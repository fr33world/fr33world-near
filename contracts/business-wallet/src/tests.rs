use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn as_caller(who: &str) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(id("market.testnet"))
        .predecessor_account_id(id(who))
        .block_timestamp(5 * DAY_NS)
        .build());
}

fn wallet() -> BusinessWallet {
    as_caller("admin.testnet");
    BusinessWallet::new(
        "Market".into(),
        id("usdc.testnet"),
        id("admin.testnet"),
        id("worker.testnet"),
        U128(100),
        U128(150),
        vec![id("farm.testnet")],
    )
}

fn funded(amount: u128) -> BusinessWallet {
    let mut w = wallet();
    as_caller("usdc.testnet");
    let _ = w.ft_on_transfer(id("player.testnet"), U128(amount), "sale-1".into());
    as_caller("worker.testnet");
    w
}

#[test]
fn a_sale_adds_to_the_balance_once() {
    let mut w = funded(500);
    assert_eq!(w.summary().balance.0, 500);
    as_caller("usdc.testnet");
    let again = w.ft_on_transfer(id("player.testnet"), U128(500), "sale-1".into());
    assert!(matches!(again, PromiseOrValue::Value(U128(500))));
    assert_eq!(w.summary().balance.0, 500);
}

#[test]
#[should_panic(expected = "only USDC is accepted")]
fn other_tokens_are_refused() {
    let mut w = wallet();
    as_caller("fake.testnet");
    let _ = w.ft_on_transfer(id("player.testnet"), U128(5), "sale-2".into());
}

#[test]
fn paying_a_supplier_takes_the_balance() {
    let mut w = funded(500);
    let _ = w.pay_supplier("o-1".into(), id("farm.testnet"), U128(80));
    let s = w.summary();
    assert_eq!(s.balance.0, 420);
    assert_eq!(s.spent_today.0, 80);
    assert_eq!(w.get_order("o-1".into()).unwrap().status, Status::Pending);
}

#[test]
#[should_panic(expected = "operator only")]
fn only_the_operator_pays() {
    let mut w = funded(500);
    as_caller("stranger.testnet");
    let _ = w.pay_supplier("o-1".into(), id("farm.testnet"), U128(80));
}

#[test]
#[should_panic(expected = "operator only")]
fn the_admin_cannot_pay_either() {
    let mut w = funded(500);
    as_caller("admin.testnet");
    let _ = w.pay_supplier("o-1".into(), id("farm.testnet"), U128(80));
}

#[test]
#[should_panic(expected = "supplier is not approved")]
fn unapproved_suppliers_are_refused() {
    let mut w = funded(500);
    let _ = w.pay_supplier("o-1".into(), id("attacker.testnet"), U128(80));
}

#[test]
#[should_panic(expected = "over the per-payment limit")]
fn the_payment_limit_holds() {
    let mut w = funded(500);
    let _ = w.pay_supplier("o-1".into(), id("farm.testnet"), U128(101));
}

#[test]
#[should_panic(expected = "over the daily limit")]
fn the_daily_limit_holds() {
    let mut w = funded(500);
    let _ = w.pay_supplier("o-1".into(), id("farm.testnet"), U128(100));
    let _ = w.pay_supplier("o-2".into(), id("farm.testnet"), U128(51));
}

#[test]
fn the_allowance_comes_back_the_next_day() {
    let mut w = funded(500);
    let _ = w.pay_supplier("o-1".into(), id("farm.testnet"), U128(100));
    testing_env!(VMContextBuilder::new()
        .current_account_id(id("market.testnet"))
        .predecessor_account_id(id("worker.testnet"))
        .block_timestamp(6 * DAY_NS)
        .build());
    let _ = w.pay_supplier("o-2".into(), id("farm.testnet"), U128(100));
    assert_eq!(w.summary().spent_today.0, 100);
}

#[test]
#[should_panic(expected = "order already exists")]
fn an_order_never_pays_twice() {
    let mut w = funded(500);
    let _ = w.pay_supplier("o-1".into(), id("farm.testnet"), U128(10));
    let _ = w.pay_supplier("o-1".into(), id("farm.testnet"), U128(10));
}

#[test]
#[should_panic(expected = "not enough free balance")]
fn nothing_is_spent_that_is_not_there() {
    let mut w = funded(50);
    let _ = w.pay_supplier("o-1".into(), id("farm.testnet"), U128(51));
}

#[test]
#[should_panic(expected = "not enough free balance")]
fn held_money_cannot_be_spent() {
    let mut w = funded(100);
    w.post_job("j-1".into(), U128(80));
    let _ = w.pay_supplier("o-1".into(), id("farm.testnet"), U128(21));
}

#[test]
fn a_job_pays_its_worker_from_what_was_held() {
    let mut w = funded(100);
    w.post_job("j-1".into(), U128(80));
    assert_eq!(w.summary().reserved.0, 80);
    w.assign_job("j-1".into(), id("player.testnet"));
    let _ = w.release_job("j-1".into());
    let s = w.summary();
    assert_eq!((s.balance.0, s.reserved.0), (20, 0));
    assert_eq!(w.get_job("j-1".into()).unwrap().status, JobStatus::Releasing);
}

#[test]
#[should_panic(expected = "job is not open")]
fn a_job_cannot_be_reassigned() {
    let mut w = funded(100);
    w.post_job("j-1".into(), U128(80));
    w.assign_job("j-1".into(), id("player.testnet"));
    w.assign_job("j-1".into(), id("attacker.testnet"));
}

#[test]
#[should_panic(expected = "job is not assigned")]
fn a_job_cannot_be_released_twice() {
    let mut w = funded(100);
    w.post_job("j-1".into(), U128(80));
    w.assign_job("j-1".into(), id("player.testnet"));
    let _ = w.release_job("j-1".into());
    let _ = w.release_job("j-1".into());
}

#[test]
fn cancelling_frees_the_money() {
    let mut w = funded(100);
    w.post_job("j-1".into(), U128(80));
    w.cancel_job("j-1".into());
    assert_eq!(w.summary().reserved.0, 0);
    assert_eq!(w.summary().balance.0, 100);
}

#[test]
#[should_panic(expected = "admin only")]
fn the_operator_cannot_raise_its_own_limits() {
    let mut w = funded(100);
    w.set_limits(U128(1_000_000), U128(1_000_000));
}

#[test]
#[should_panic(expected = "admin only")]
fn the_operator_cannot_approve_suppliers() {
    let mut w = funded(100);
    w.approve_supplier(id("attacker.testnet"));
}

#[test]
fn a_failed_payment_returns_the_money() {
    let mut w = funded(500);
    let _ = w.pay_supplier("o-1".into(), id("farm.testnet"), U128(80));
    testing_env!(VMContextBuilder::new()
        .current_account_id(id("market.testnet"))
        .predecessor_account_id(id("market.testnet"))
        .block_timestamp(5 * DAY_NS)
        .build());
    w.on_order_paid("o-1".into(), Err(PromiseError::Failed));
    let s = w.summary();
    assert_eq!((s.balance.0, s.spent_today.0), (500, 0));
    assert_eq!(w.get_order("o-1".into()).unwrap().status, Status::Failed);
}

#[test]
fn a_failed_job_payment_can_be_retried_for_the_same_worker() {
    let mut w = funded(100);
    w.post_job("j-1".into(), U128(80));
    w.assign_job("j-1".into(), id("player.testnet"));
    let _ = w.release_job("j-1".into());
    testing_env!(VMContextBuilder::new()
        .current_account_id(id("market.testnet"))
        .predecessor_account_id(id("market.testnet"))
        .block_timestamp(5 * DAY_NS)
        .build());
    w.on_job_paid("j-1".into(), Err(PromiseError::Failed));
    let s = w.summary();
    assert_eq!((s.balance.0, s.reserved.0), (100, 80));
    let job = w.get_job("j-1".into()).unwrap();
    assert_eq!(job.status, JobStatus::Assigned);
    assert_eq!(job.worker, Some(id("player.testnet")));
}

#[test]
#[should_panic(expected = "still in its waiting period")]
fn a_stolen_admin_key_cannot_pay_a_new_supplier_at_once() {
    let mut w = funded(500);
    as_caller("admin.testnet");
    w.approve_supplier(id("attacker.testnet"));
    as_caller("worker.testnet");
    let _ = w.pay_supplier("o-1".into(), id("attacker.testnet"), U128(10));
}

#[test]
fn a_new_supplier_can_be_paid_after_the_wait() {
    let mut w = funded(500);
    as_caller("admin.testnet");
    w.approve_supplier(id("mill.testnet"));
    testing_env!(VMContextBuilder::new()
        .current_account_id(id("market.testnet"))
        .predecessor_account_id(id("worker.testnet"))
        .block_timestamp(6 * DAY_NS)
        .build());
    let _ = w.pay_supplier("o-1".into(), id("mill.testnet"), U128(10));
    assert_eq!(w.summary().balance.0, 490);
}

fn as_self() {
    testing_env!(VMContextBuilder::new()
        .current_account_id(id("market.testnet"))
        .predecessor_account_id(id("market.testnet"))
        .block_timestamp(5 * DAY_NS)
        .build());
}

#[test]
fn a_supplier_that_refused_part_gets_only_what_moved() {
    let mut w = funded(500);
    let _ = w.pay_supplier("o-1".into(), id("farm.testnet"), U128(80));
    as_self();
    w.on_order_paid("o-1".into(), Ok(U128(30)));
    assert_eq!(w.summary().balance.0, 470);
    assert_eq!(w.get_order("o-1".into()).unwrap().status, Status::Failed);
}

#[test]
fn a_paid_order_is_marked_paid() {
    let mut w = funded(500);
    let _ = w.pay_supplier("o-1".into(), id("farm.testnet"), U128(80));
    as_self();
    w.on_order_paid("o-1".into(), Ok(U128(80)));
    assert_eq!(w.get_order("o-1".into()).unwrap().status, Status::Paid);
    assert_eq!(w.summary().balance.0, 420);
}

#[test]
fn sync_counts_money_sent_without_a_message() {
    let mut w = funded(500);
    as_self();
    w.on_synced(Ok(U128(700)));
    assert_eq!(w.summary().balance.0, 700);
}

#[test]
fn sync_never_lowers_the_books() {
    let mut w = funded(500);
    as_self();
    w.on_synced(Ok(U128(100)));
    assert_eq!(w.summary().balance.0, 500);
}

#[test]
#[should_panic(expected = "a payment is in flight")]
fn sync_waits_for_payments_in_flight() {
    let mut w = funded(500);
    let _ = w.pay_supplier("o-1".into(), id("farm.testnet"), U128(80));
    let _ = w.sync();
}

#[test]
fn sync_ignores_an_answer_overtaken_by_a_payment() {
    let mut w = funded(500);
    let _ = w.pay_supplier("o-1".into(), id("farm.testnet"), U128(80));
    as_self();
    w.on_synced(Ok(U128(500)));
    assert_eq!(w.summary().balance.0, 420);
}
