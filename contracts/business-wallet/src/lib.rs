//! A business's wallet: one of these runs on each business's own NEAR account.
//!
//! The game's worker holds only the `operator` key. Whatever it (or an AI behind it) asks for,
//! this contract refuses a payment that is over a limit, to a supplier that isn't approved, more
//! than the free balance, or a repeat of an order already paid. There is no withdraw method, so
//! USDC leaves only as a supplier payment or a job's pay, and always within the limits. The
//! admin sets limits and suppliers but moves no money. A supplier added after setup can't be
//! paid for a day (`SUPPLIER_DELAY_NS`), so a stolen admin key can't quietly drain a business:
//! the new supplier is public on chain first, and can be removed.
//! All USDC arrives from customers through `ft_on_transfer`; the game adds none of its own.
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

const DAY_NS: u64 = 86_400_000_000_000;
/// How long a supplier added after setup waits before it can be paid.
const SUPPLIER_DELAY_NS: u64 = DAY_NS;
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
/// Enough for the receiver to do real work: buying a car pays its seller and a cut onward.
const GAS_FT_TRANSFER_CALL: Gas = Gas::from_tgas(170);
const GAS_FT_BALANCE: Gas = Gas::from_tgas(5);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_CARS: Gas = Gas::from_tgas(15);
const MAX_ID: usize = 64;

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum Key {
    Suppliers,
    Orders,
    Jobs,
    Sales,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
pub enum Status {
    /// Sent to the token contract, waiting for its answer.
    Pending,
    Paid,
    Failed,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
pub enum JobStatus {
    Open,
    Assigned,
    Releasing,
    Paid,
    Cancelled,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, PartialEq, Debug)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct Order {
    pub to: AccountId,
    pub amount: U128,
    pub status: Status,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, PartialEq, Debug)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct Job {
    pub amount: U128,
    /// Fixed once assigned: the only account this job can ever pay.
    pub worker: Option<AccountId>,
    pub status: JobStatus,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Summary {
    pub name: String,
    pub usdc: AccountId,
    pub admin: AccountId,
    pub operator: AccountId,
    pub per_payment: U128,
    pub per_day: U128,
    pub balance: U128,
    pub reserved: U128,
    pub spent_today: U128,
    pub suppliers: Vec<AccountId>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct BusinessWallet {
    name: String,
    usdc: AccountId,
    admin: AccountId,
    operator: AccountId,
    per_payment: u128,
    per_day: u128,
    /// USDC received less USDC sent, in the token's smallest units.
    balance: u128,
    /// Held for open jobs; can't be spent on anything else.
    reserved: u128,
    /// Sent to the token contract and not yet answered: `sync` waits while there is any.
    in_flight: u128,
    day: u64,
    spent_today: u128,
    /// Each approved supplier, and when it can first be paid.
    suppliers: IterableMap<AccountId, u64>,
    orders: LookupMap<String, Order>,
    jobs: LookupMap<String, Job>,
    sales: LookupMap<String, U128>,
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> U128;
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}

#[ext_contract(ext_cars)]
#[allow(dead_code)]
trait Cars {
    fn list_car(&mut self, token_id: String, price: U128);
    fn delist_car(&mut self, token_id: String);
}

fn event(kind: &str, data: String) {
    log!(
        "EVENT_JSON:{{\"standard\":\"fr33world\",\"version\":\"1.0.0\",\"event\":\"{}\",\"data\":[{}]}}",
        kind,
        data
    );
}

fn check_id(id: &str) {
    require!(!id.is_empty() && id.len() <= MAX_ID, "bad id");
    require!(
        id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b':'),
        "bad id"
    );
}

#[near]
impl BusinessWallet {
    #[init]
    pub fn new(
        name: String,
        usdc: AccountId,
        admin: AccountId,
        operator: AccountId,
        per_payment: U128,
        per_day: U128,
        suppliers: Vec<AccountId>,
    ) -> Self {
        require!(per_payment.0 <= per_day.0, "per payment is over the daily limit");
        let mut approved = IterableMap::new(Key::Suppliers);
        for s in suppliers {
            approved.insert(s, 0);
        }
        Self {
            name,
            usdc,
            admin,
            operator,
            per_payment: per_payment.0,
            per_day: per_day.0,
            balance: 0,
            reserved: 0,
            in_flight: 0,
            day: 0,
            spent_today: 0,
            suppliers: approved,
            orders: LookupMap::new(Key::Orders),
            jobs: LookupMap::new(Key::Jobs),
            sales: LookupMap::new(Key::Sales),
        }
    }

    // ---- Money in -------------------------------------------------------------------------

    /// USDC arriving by `ft_transfer_call`. `msg` is the sale's id; a repeat is sent back.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.usdc, "only USDC is accepted");
        check_id(&msg);
        if self.sales.contains_key(&msg) {
            return PromiseOrValue::Value(amount);
        }
        self.sales.insert(msg.clone(), amount);
        self.balance = self.balance.checked_add(amount.0).expect("overflow");
        event(
            "sale",
            format!(
                "{{\"sale\":\"{}\",\"from\":\"{}\",\"amount\":\"{}\"}}",
                msg, sender_id, amount.0
            ),
        );
        PromiseOrValue::Value(U128(0))
    }

    // ---- Money out (the operator, within the limits) --------------------------------------

    /// Pays an approved supplier for an order. The same order id never pays twice.
    pub fn pay_supplier(&mut self, order_id: String, to: AccountId, amount: U128) -> Promise {
        self.only_operator();
        check_id(&order_id);
        let active_from = *self.suppliers.get(&to).expect("supplier is not approved");
        require!(env::block_timestamp() >= active_from, "supplier is still in its waiting period");
        require!(!self.orders.contains_key(&order_id), "order already exists");
        require!(amount.0 <= self.free(), "not enough free balance");
        self.charge(amount.0);
        self.orders.insert(
            order_id.clone(),
            Order { to: to.clone(), amount, status: Status::Pending },
        );
        // A call, not a plain transfer: the supplier's own wallet has to hear about the money.
        ext_ft::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER_CALL)
            .ft_transfer_call(to, amount, Some(order_id.clone()), order_id.clone())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_order_paid(order_id),
            )
    }

    /// Holds USDC for a job anyone may be given. The money can't be spent while it's held.
    pub fn post_job(&mut self, job_id: String, amount: U128) {
        self.only_operator();
        check_id(&job_id);
        require!(amount.0 > 0, "no pay");
        require!(amount.0 <= self.per_payment, "over the per-payment limit");
        require!(!self.jobs.contains_key(&job_id), "job already exists");
        require!(amount.0 <= self.free(), "not enough free balance");
        self.reserved += amount.0;
        self.jobs.insert(
            job_id.clone(),
            Job { amount, worker: None, status: JobStatus::Open },
        );
        event("job_posted", format!("{{\"job\":\"{}\",\"amount\":\"{}\"}}", job_id, amount.0));
    }

    /// Fixes who a job pays. It can't be changed afterwards, only cancelled.
    pub fn assign_job(&mut self, job_id: String, worker: AccountId) {
        self.only_operator();
        let mut job = self.job(&job_id);
        require!(job.status == JobStatus::Open, "job is not open");
        job.worker = Some(worker.clone());
        job.status = JobStatus::Assigned;
        self.jobs.insert(job_id.clone(), job);
        event("job_assigned", format!("{{\"job\":\"{}\",\"worker\":\"{}\"}}", job_id, worker));
    }

    /// The work is done: pays the job's worker from the money held for it.
    pub fn release_job(&mut self, job_id: String) -> Promise {
        self.only_operator();
        let mut job = self.job(&job_id);
        require!(job.status == JobStatus::Assigned, "job is not assigned");
        let worker = job.worker.clone().expect("assigned job has a worker");
        let amount = job.amount;
        self.reserved -= amount.0;
        self.charge(amount.0);
        job.status = JobStatus::Releasing;
        self.jobs.insert(job_id.clone(), job);
        ext_ft::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(worker, amount, Some(job_id.clone()))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_job_paid(job_id),
            )
    }

    /// Gives up a job not yet paid: its money is free again.
    pub fn cancel_job(&mut self, job_id: String) {
        self.only_operator();
        let mut job = self.job(&job_id);
        require!(
            job.status == JobStatus::Open || job.status == JobStatus::Assigned,
            "job can't be cancelled"
        );
        self.reserved -= job.amount.0;
        job.status = JobStatus::Cancelled;
        self.jobs.insert(job_id.clone(), job);
        event("job_cancelled", format!("{{\"job\":\"{}\"}}", job_id));
    }

    // ---- Cars this business owns (bought back through `pay_supplier` to the cars contract) --

    /// Puts a car this business owns up for sale on an approved cars contract. The money from
    /// a sale comes back here by plain transfer, so `sync` counts it.
    pub fn list_car(&mut self, cars: AccountId, token_id: String, price: U128) -> Promise {
        self.only_operator();
        self.approved_now(&cars);
        check_id(&token_id);
        ext_cars::ext(cars)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_CARS)
            .list_car(token_id, price)
    }

    pub fn delist_car(&mut self, cars: AccountId, token_id: String) -> Promise {
        self.only_operator();
        self.approved_now(&cars);
        check_id(&token_id);
        ext_cars::ext(cars)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_CARS)
            .delist_car(token_id)
    }

    // ---- Answers from the token contract --------------------------------------------------

    #[private]
    pub fn on_order_paid(
        &mut self,
        order_id: String,
        #[callback_result] result: Result<U128, PromiseError>,
    ) {
        let mut order = self.orders.get(&order_id).expect("no order").clone();
        self.in_flight -= order.amount.0;
        // What the token says it really moved: anything less comes back to this wallet.
        let moved = result.map(|used| used.0).unwrap_or(0);
        if moved == order.amount.0 {
            order.status = Status::Paid;
            event(
                "order_paid",
                format!(
                    "{{\"order\":\"{}\",\"to\":\"{}\",\"amount\":\"{}\"}}",
                    order_id, order.to, order.amount.0
                ),
            );
        } else {
            order.status = Status::Failed;
            self.refund(order.amount.0 - moved);
            event("order_failed", format!("{{\"order\":\"{}\"}}", order_id));
        }
        self.orders.insert(order_id, order);
    }

    #[private]
    pub fn on_job_paid(
        &mut self,
        job_id: String,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        let mut job = self.job(&job_id);
        self.in_flight -= job.amount.0;
        if result.is_ok() {
            job.status = JobStatus::Paid;
            event(
                "job_paid",
                format!(
                    "{{\"job\":\"{}\",\"worker\":\"{}\",\"amount\":\"{}\"}}",
                    job_id,
                    job.worker.as_ref().expect("worker"),
                    job.amount.0
                ),
            );
        } else {
            // Back to assigned, the money held again: the same worker can be paid on a retry.
            self.refund(job.amount.0);
            self.reserved += job.amount.0;
            job.status = JobStatus::Assigned;
            event("job_payment_failed", format!("{{\"job\":\"{}\"}}", job_id));
        }
        self.jobs.insert(job_id, job);
    }

    // ---- Money that arrived without a message --------------------------------------------

    /// Counts USDC sent here by a plain transfer, which this wallet never hears about. Anyone
    /// may call it: it only ever raises the books to what the token contract says is here.
    pub fn sync(&mut self) -> Promise {
        require!(self.in_flight == 0, "a payment is in flight");
        ext_ft::ext(self.usdc.clone())
            .with_static_gas(GAS_FT_BALANCE)
            .ft_balance_of(env::current_account_id())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_synced())
    }

    #[private]
    pub fn on_synced(&mut self, #[callback_result] result: Result<U128, PromiseError>) {
        let Ok(actual) = result else { return };
        // A payment started since the question was asked would look like extra money.
        if self.in_flight == 0 && actual.0 > self.balance {
            event(
                "synced",
                format!("{{\"found\":\"{}\"}}", actual.0 - self.balance),
            );
            self.balance = actual.0;
        }
    }

    // ---- The admin: limits and suppliers, never money --------------------------------------

    pub fn set_limits(&mut self, per_payment: U128, per_day: U128) {
        self.only_admin();
        require!(per_payment.0 <= per_day.0, "per payment is over the daily limit");
        self.per_payment = per_payment.0;
        self.per_day = per_day.0;
    }

    pub fn approve_supplier(&mut self, account: AccountId) {
        self.only_admin();
        let active_from = env::block_timestamp() + SUPPLIER_DELAY_NS;
        event(
            "supplier_added",
            format!("{{\"supplier\":\"{}\",\"active_from\":\"{}\"}}", account, active_from),
        );
        self.suppliers.insert(account, active_from);
    }

    pub fn remove_supplier(&mut self, account: AccountId) {
        self.only_admin();
        self.suppliers.remove(&account);
    }

    pub fn set_operator(&mut self, operator: AccountId) {
        self.only_admin();
        self.operator = operator;
    }

    // ---- Views ------------------------------------------------------------------------------

    pub fn summary(&self) -> Summary {
        Summary {
            name: self.name.clone(),
            usdc: self.usdc.clone(),
            admin: self.admin.clone(),
            operator: self.operator.clone(),
            per_payment: U128(self.per_payment),
            per_day: U128(self.per_day),
            balance: U128(self.balance),
            reserved: U128(self.reserved),
            spent_today: U128(self.spent_for(env::block_timestamp() / DAY_NS)),
            suppliers: self.suppliers.keys().cloned().collect(),
        }
    }

    pub fn get_order(&self, order_id: String) -> Option<Order> {
        self.orders.get(&order_id).cloned()
    }

    pub fn get_job(&self, job_id: String) -> Option<Job> {
        self.jobs.get(&job_id).cloned()
    }

    pub fn get_sale(&self, sale_id: String) -> Option<U128> {
        self.sales.get(&sale_id).copied()
    }
}

impl BusinessWallet {
    fn only_operator(&self) {
        require!(env::predecessor_account_id() == self.operator, "operator only");
    }

    fn only_admin(&self) {
        require!(env::predecessor_account_id() == self.admin, "admin only");
    }

    fn approved_now(&self, account: &AccountId) {
        let active_from = *self.suppliers.get(account).expect("supplier is not approved");
        require!(env::block_timestamp() >= active_from, "supplier is still in its waiting period");
    }

    fn free(&self) -> u128 {
        self.balance - self.reserved
    }

    fn job(&self, id: &str) -> Job {
        self.jobs.get(id).cloned().expect("no job")
    }

    fn spent_for(&self, day: u64) -> u128 {
        if day == self.day {
            self.spent_today
        } else {
            0
        }
    }

    /// Takes `amount` off the balance and the day's allowance, or refuses.
    fn charge(&mut self, amount: u128) {
        require!(amount > 0, "no amount");
        require!(amount <= self.per_payment, "over the per-payment limit");
        let today = env::block_timestamp() / DAY_NS;
        let spent = self.spent_for(today) + amount;
        require!(spent <= self.per_day, "over the daily limit");
        self.day = today;
        self.spent_today = spent;
        self.balance -= amount;
        self.in_flight += amount;
    }

    /// A payment that failed: the money never left, so it's back in the balance and allowance.
    fn refund(&mut self, amount: u128) {
        self.balance += amount;
        self.spent_today = self.spent_today.saturating_sub(amount);
    }
}

#[cfg(test)]
mod tests;
