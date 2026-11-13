//! fr33world's cars on NEAR: each car a player owns is a NEP-171 token in their own wallet, its
//! title deed. The game mints one when a car is bought at the dealership (paid in `$`, off
//! chain); from then on the car is the player's, whatever the game later thinks of them. It
//! shows in any NEAR wallet, can be sent to any account, and can be sold to another player for
//! USDC here, with no one else able to stop or reverse the sale.
//!
//! Selling: the owner lists a car at a USDC price; a buyer pays that exact price with the USDC
//! contract's `ft_transfer_call` (`msg` is the car's token id). In the same step the car moves
//! to the buyer, the seller is paid, and the dealership's wallet gets its cut (`fee_bps`). If a
//! payout fails (say the seller can't hold USDC yet) the money waits here under their name and
//! they `claim` it later: nothing is lost and nothing goes back to the game.
//!
//! A new or newly sold car is locked for a while (`lock_after_mint_ns`, `lock_after_sale_ns`):
//! it can't be sent or listed until then, so farming cars to cash them out at once doesn't pay.
//! The admin sets the cut and the locks within hard caps; the minter only mints. Neither can
//! move a car or anyone's USDC.
use std::collections::HashMap;

use near_contract_standards::non_fungible_token::core::{
    NonFungibleTokenCore, NonFungibleTokenResolver,
};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    assert_one_yocto, env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas,
    NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

const DAY_NS: u64 = 86_400_000_000_000;
/// The most a lock can be: a week.
const MAX_LOCK_NS: u64 = 7 * DAY_NS;
/// The most the dealership's cut can be: 10%.
const MAX_FEE_BPS: u16 = 1_000;
/// Listing prices, in the token's smallest units (USDC has 6 decimals): 1 to 1,000,000 USDC.
const MIN_PRICE: u128 = 1_000_000;
const MAX_PRICE: u128 = 1_000_000_000_000;
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FT_TRANSFER_CALL: Gas = Gas::from_tgas(40);
const GAS_CALLBACK: Gas = Gas::from_tgas(5);

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum Key {
    Owners,
    Metadata,
    Enumeration,
    Listings,
    Locks,
    Owed,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, PartialEq, Debug)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct Listing {
    pub seller: AccountId,
    /// The exact USDC a buyer must send.
    pub price: U128,
    pub listed_at: u64,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Config {
    pub usdc: AccountId,
    pub admin: AccountId,
    pub minter: AccountId,
    pub dealer: AccountId,
    pub fee_bps: u16,
    pub lock_after_mint_ns: u64,
    pub lock_after_sale_ns: u64,
    /// USDC the dealership's cut couldn't be paid yet; `pay_fees` sends it.
    pub fees_owed: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Cars {
    tokens: NonFungibleToken,
    metadata: NFTContractMetadata,
    usdc: AccountId,
    admin: AccountId,
    minter: AccountId,
    /// The dealership's business wallet (contracts/business-wallet): it gets the cut.
    dealer: AccountId,
    fee_bps: u16,
    lock_after_mint_ns: u64,
    lock_after_sale_ns: u64,
    listings: IterableMap<TokenId, Listing>,
    /// When each car may next be sent or listed.
    locks: LookupMap<TokenId, u64>,
    /// USDC held for sellers whose payout failed, until they claim it.
    owed: LookupMap<AccountId, u128>,
    fees_owed: u128,
    /// Counts sales, so each cut sent to the dealership has its own id.
    sales: u64,
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
}

fn event(kind: &str, data: String) {
    log!(
        "EVENT_JSON:{{\"standard\":\"fr33world_cars\",\"version\":\"1.0.0\",\"event\":\"{}\",\"data\":[{}]}}",
        kind,
        data
    );
}

#[near]
impl Cars {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        usdc: AccountId,
        admin: AccountId,
        minter: AccountId,
        dealer: AccountId,
        fee_bps: u16,
        lock_after_mint_ns: u64,
        lock_after_sale_ns: u64,
        base_uri: Option<String>,
    ) -> Self {
        require!(fee_bps <= MAX_FEE_BPS, "fee is over the cap");
        require!(
            lock_after_mint_ns <= MAX_LOCK_NS && lock_after_sale_ns <= MAX_LOCK_NS,
            "lock is over the cap"
        );
        Self {
            tokens: NonFungibleToken::new(
                Key::Owners,
                env::current_account_id(),
                Some(Key::Metadata),
                Some(Key::Enumeration),
                None::<Key>,
            ),
            metadata: NFTContractMetadata {
                spec: NFT_METADATA_SPEC.to_string(),
                name: "fr33world cars".to_string(),
                symbol: "F33CAR".to_string(),
                icon: None,
                base_uri,
                reference: None,
                reference_hash: None,
            },
            usdc,
            admin,
            minter,
            dealer,
            fee_bps,
            lock_after_mint_ns,
            lock_after_sale_ns,
            listings: IterableMap::new(Key::Listings),
            locks: LookupMap::new(Key::Locks),
            owed: LookupMap::new(Key::Owed),
            fees_owed: 0,
            sales: 0,
        }
    }

    // ---- Minting (the game, when a car is bought at the dealership) ------------------------

    /// Mints a car to its owner. The same token id can never be minted twice. Storage is paid
    /// from this contract's own balance, so players need nothing to receive a car.
    pub fn mint_car(&mut self, token_id: TokenId, owner: AccountId, metadata: TokenMetadata) -> Token {
        require!(env::predecessor_account_id() == self.minter, "minter only");
        require!(!token_id.is_empty() && token_id.len() <= 64, "bad token id");
        require!(
            token_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'),
            "bad token id"
        );
        let token = self.tokens.internal_mint_with_refund(token_id, owner, Some(metadata), None);
        NftMint { owner_id: &token.owner_id, token_ids: &[&token.token_id], memo: None }.emit();
        self.locks.insert(token.token_id.clone(), env::block_timestamp() + self.lock_after_mint_ns);
        token
    }

    // ---- Selling for USDC ----------------------------------------------------------------

    /// Puts your car up for sale at `price` USDC. Listing again changes the price.
    #[payable]
    pub fn list_car(&mut self, token_id: TokenId, price: U128) {
        assert_one_yocto();
        let seller = env::predecessor_account_id();
        require!(self.owner_of(&token_id) == seller, "not your car");
        self.require_unlocked(&token_id);
        require!(price.0 >= MIN_PRICE && price.0 <= MAX_PRICE, "price is out of range");
        self.listings.insert(
            token_id.clone(),
            Listing { seller: seller.clone(), price, listed_at: env::block_timestamp() },
        );
        event(
            "listed",
            format!(
                "{{\"token_id\":\"{}\",\"seller\":\"{}\",\"price\":\"{}\"}}",
                token_id, seller, price.0
            ),
        );
    }

    /// Takes your car off sale.
    #[payable]
    pub fn delist_car(&mut self, token_id: TokenId) {
        assert_one_yocto();
        let listing = self.listings.get(&token_id).cloned().expect("not for sale");
        require!(listing.seller == env::predecessor_account_id(), "not your listing");
        self.listings.remove(&token_id);
        event("delisted", format!("{{\"token_id\":\"{}\"}}", token_id));
    }

    /// USDC arriving by `ft_transfer_call`: buys the listed car named in `msg` at its exact
    /// price. Anything else is sent straight back, untouched.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.usdc, "only USDC is accepted");
        // A business wallet's payment carries its own order id after the car's: `car-12:o-3f`.
        let token_id: TokenId = msg.split(':').next().unwrap_or_default().to_string();
        let Some(listing) = self.listings.get(&token_id).cloned() else {
            log!("not for sale: refunded");
            return PromiseOrValue::Value(amount);
        };
        if amount.0 != listing.price.0 || sender_id == listing.seller {
            log!("wrong amount or own car: refunded");
            return PromiseOrValue::Value(amount);
        }
        let seller = listing.seller.clone();
        self.listings.remove(&token_id);
        self.tokens.internal_transfer(&seller, &sender_id, &token_id, None, Some("sold".into()));
        self.locks.insert(token_id.clone(), env::block_timestamp() + self.lock_after_sale_ns);

        // The dealership doesn't take a cut of its own sales.
        let fee = if seller == self.dealer {
            0
        } else {
            amount.0 * u128::from(self.fee_bps) / 10_000
        };
        let to_seller = amount.0 - fee;
        self.sales += 1;
        event(
            "sold",
            format!(
                "{{\"token_id\":\"{}\",\"seller\":\"{}\",\"buyer\":\"{}\",\"price\":\"{}\",\"fee\":\"{}\"}}",
                token_id, seller, sender_id, amount.0, fee
            ),
        );
        self.pay_out(seller, to_seller, format!("car {} sold", token_id));
        if fee > 0 {
            let _ = self.send_fee(fee);
        }
        PromiseOrValue::Value(U128(0))
    }

    /// Sends you the USDC a failed payout left here.
    pub fn claim(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amount = self.owed.remove(&who).expect("nothing owed");
        self.payout_promise(who, amount, "claimed".into())
    }

    /// Sends the dealership any cut that couldn't be paid at the time. Anyone may call it.
    pub fn pay_fees(&mut self) -> Promise {
        require!(self.fees_owed > 0, "no fees owed");
        let amount = std::mem::take(&mut self.fees_owed);
        self.send_fee(amount)
    }

    // ---- Answers from the token contract --------------------------------------------------

    #[private]
    pub fn on_paid(
        &mut self,
        to: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_err() {
            let had = self.owed.get(&to).copied().unwrap_or(0);
            self.owed.insert(to.clone(), had + amount.0);
            event("payout_held", format!("{{\"to\":\"{}\",\"amount\":\"{}\"}}", to, amount.0));
        }
    }

    #[private]
    pub fn on_fee(&mut self, amount: U128, #[callback_result] result: Result<U128, PromiseError>) {
        let used = result.map(|u| u.0).unwrap_or(0);
        if used < amount.0 {
            self.fees_owed += amount.0 - used;
        }
    }

    // ---- The admin: the cut and the locks, within the caps ---------------------------------

    pub fn set_fee(&mut self, fee_bps: u16) {
        self.only_admin();
        require!(fee_bps <= MAX_FEE_BPS, "fee is over the cap");
        self.fee_bps = fee_bps;
    }

    pub fn set_locks(&mut self, after_mint_ns: u64, after_sale_ns: u64) {
        self.only_admin();
        require!(after_mint_ns <= MAX_LOCK_NS && after_sale_ns <= MAX_LOCK_NS, "lock is over the cap");
        self.lock_after_mint_ns = after_mint_ns;
        self.lock_after_sale_ns = after_sale_ns;
    }

    pub fn set_minter(&mut self, minter: AccountId) {
        self.only_admin();
        self.minter = minter;
    }

    // ---- Views ------------------------------------------------------------------------------

    pub fn config(&self) -> Config {
        Config {
            usdc: self.usdc.clone(),
            admin: self.admin.clone(),
            minter: self.minter.clone(),
            dealer: self.dealer.clone(),
            fee_bps: self.fee_bps,
            lock_after_mint_ns: self.lock_after_mint_ns,
            lock_after_sale_ns: self.lock_after_sale_ns,
            fees_owed: U128(self.fees_owed),
        }
    }

    pub fn get_listing(&self, token_id: TokenId) -> Option<Listing> {
        self.listings.get(&token_id).cloned()
    }

    pub fn listings(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<(TokenId, Listing)> {
        self.listings
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// When the car may next be sent or listed (nanoseconds); 0 if it's free now.
    pub fn locked_until(&self, token_id: TokenId) -> u64 {
        let until = self.locks.get(&token_id).copied().unwrap_or(0);
        if until > env::block_timestamp() {
            until
        } else {
            0
        }
    }

    pub fn owed_to(&self, account_id: AccountId) -> U128 {
        U128(self.owed.get(&account_id).copied().unwrap_or(0))
    }
}

impl Cars {
    fn only_admin(&self) {
        require!(env::predecessor_account_id() == self.admin, "admin only");
    }

    fn owner_of(&self, token_id: &TokenId) -> AccountId {
        self.tokens.owner_by_id.get(token_id).expect("no such car")
    }

    fn require_unlocked(&self, token_id: &TokenId) {
        let until = self.locks.get(token_id).copied().unwrap_or(0);
        require!(env::block_timestamp() >= until, "this car is still locked");
    }

    /// Before any send: the lock must be over, and a car that moves is no longer for sale.
    fn before_send(&mut self, token_id: &TokenId) {
        self.require_unlocked(token_id);
        if self.listings.remove(token_id).is_some() {
            event("delisted", format!("{{\"token_id\":\"{}\"}}", token_id));
        }
    }

    fn payout_promise(&self, to: AccountId, amount: u128, memo: String) -> Promise {
        ext_ft::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(to.clone(), U128(amount), Some(memo))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_paid(to, U128(amount)),
            )
    }

    fn pay_out(&self, to: AccountId, amount: u128, memo: String) {
        if amount > 0 {
            let _ = self.payout_promise(to, amount, memo);
        }
    }

    /// The dealership's wallet only counts USDC that arrives with an id, so the cut goes by
    /// `ft_transfer_call` with this sale's own id.
    fn send_fee(&mut self, amount: u128) -> Promise {
        let id = format!("cut-{}-{}", env::block_height(), self.sales);
        ext_ft::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER_CALL)
            .ft_transfer_call(self.dealer.clone(), U128(amount), Some(id.clone()), id)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_fee(U128(amount)),
            )
    }
}

// ---- NEP-171: the standard parts, with the lock and listings kept in step -----------------

#[near]
impl NonFungibleTokenCore for Cars {
    #[payable]
    fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        self.before_send(&token_id);
        self.tokens.nft_transfer(receiver_id, token_id, approval_id, memo);
    }

    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        self.before_send(&token_id);
        self.tokens.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Cars {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        self.tokens.nft_resolve_transfer(previous_owner_id, receiver_id, token_id, approved_account_ids)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Cars {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }

    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Cars {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.clone()
    }
}

#[cfg(test)]
mod tests;
