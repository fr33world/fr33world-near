use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const START: u64 = 10 * DAY_NS;
const USDC: u128 = 1_000_000;

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn at(who: &str, time: u64, yocto: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(id("cars.testnet"))
        .predecessor_account_id(id(who))
        .block_timestamp(time)
        .attached_deposit(NearToken::from_yoctonear(yocto))
        .build());
}

fn as_caller(who: &str) {
    at(who, START, 0);
}

fn meta(title: &str) -> TokenMetadata {
    TokenMetadata {
        title: Some(title.into()),
        description: None,
        media: None,
        media_hash: None,
        copies: None,
        issued_at: None,
        expires_at: None,
        starts_at: None,
        updated_at: None,
        extra: None,
        reference: None,
        reference_hash: None,
    }
}

fn contract() -> Cars {
    as_caller("admin.testnet");
    Cars::new(
        id("usdc.testnet"),
        id("admin.testnet"),
        id("worker.testnet"),
        id("dealer.testnet"),
        500,
        DAY_NS,
        DAY_NS,
        None,
        None,
        None,
    )
}

/// A contract with car-1 minted to alice, its lock already over.
fn with_car() -> Cars {
    let mut c = contract();
    as_caller("worker.testnet");
    c.mint_car("car-1".into(), id("alice.testnet"), meta("Sport"));
    c
}

const LATER: u64 = START + 2 * DAY_NS;

fn listed(price: u128) -> Cars {
    let mut c = with_car();
    at("alice.testnet", LATER, 1);
    c.list_car("car-1".into(), U128(price));
    c
}

fn owner(c: &Cars, token: &str) -> AccountId {
    c.nft_token(token.into()).expect("token").owner_id
}

#[test]
fn the_minter_mints_a_car_to_its_owner() {
    let c = with_car();
    assert_eq!(owner(&c, "car-1"), id("alice.testnet"));
    assert_eq!(c.nft_supply_for_owner(id("alice.testnet")).0, 1);
    assert_eq!(c.locked_until("car-1".into()), START + DAY_NS);
}

#[test]
#[should_panic(expected = "minter only")]
fn nobody_else_can_mint() {
    let mut c = contract();
    as_caller("alice.testnet");
    c.mint_car("car-1".into(), id("alice.testnet"), meta("Sport"));
}

#[test]
#[should_panic(expected = "token_id must be unique")]
fn a_car_is_minted_once() {
    let mut c = with_car();
    as_caller("worker.testnet");
    c.mint_car("car-1".into(), id("bob.testnet"), meta("Sport"));
}

#[test]
#[should_panic(expected = "this car is still locked")]
fn a_new_car_cant_be_listed_at_once() {
    let mut c = with_car();
    at("alice.testnet", START + DAY_NS / 2, 1);
    c.list_car("car-1".into(), U128(10 * USDC));
}

#[test]
#[should_panic(expected = "this car is still locked")]
fn a_new_car_cant_be_sent_at_once() {
    let mut c = with_car();
    at("alice.testnet", START + DAY_NS / 2, 1);
    c.nft_transfer(id("bob.testnet"), "car-1".into(), None, None);
}

#[test]
#[should_panic(expected = "not your car")]
fn only_the_owner_lists() {
    let mut c = with_car();
    at("bob.testnet", LATER, 1);
    c.list_car("car-1".into(), U128(10 * USDC));
}

#[test]
#[should_panic(expected = "price is out of range")]
fn a_price_under_one_usdc_is_refused() {
    listed(USDC / 2);
}

#[test]
fn a_buyer_paying_the_price_gets_the_car() {
    let mut c = listed(10 * USDC);
    at("usdc.testnet", LATER, 0);
    let r = c.ft_on_transfer(id("bob.testnet"), U128(10 * USDC), "car-1".into());
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    assert_eq!(owner(&c, "car-1"), id("bob.testnet"));
    assert!(c.get_listing("car-1".into()).is_none());
    assert_eq!(c.locked_until("car-1".into()), LATER + DAY_NS);
    // 5% to the dealership, the rest to the seller.
    assert!(get_logs().iter().any(|l| l.contains("\"fee\":\"500000\"")));
}

#[test]
fn a_business_wallet_buys_with_its_order_id() {
    let mut c = listed(10 * USDC);
    at("usdc.testnet", LATER, 0);
    let r = c.ft_on_transfer(id("dealer.testnet"), U128(10 * USDC), "car-1:o-77".into());
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    assert_eq!(owner(&c, "car-1"), id("dealer.testnet"));
}

#[test]
fn the_wrong_amount_goes_back() {
    let mut c = listed(10 * USDC);
    at("usdc.testnet", LATER, 0);
    let r = c.ft_on_transfer(id("bob.testnet"), U128(9 * USDC), "car-1".into());
    assert!(matches!(r, PromiseOrValue::Value(U128(a)) if a == 9 * USDC));
    assert_eq!(owner(&c, "car-1"), id("alice.testnet"));
    assert!(c.get_listing("car-1".into()).is_some());
}

#[test]
fn a_car_not_for_sale_cant_be_bought() {
    let mut c = with_car();
    at("usdc.testnet", LATER, 0);
    let r = c.ft_on_transfer(id("bob.testnet"), U128(10 * USDC), "car-1".into());
    assert!(matches!(r, PromiseOrValue::Value(U128(a)) if a == 10 * USDC));
    assert_eq!(owner(&c, "car-1"), id("alice.testnet"));
}

#[test]
fn buying_your_own_car_goes_back() {
    let mut c = listed(10 * USDC);
    at("usdc.testnet", LATER, 0);
    let r = c.ft_on_transfer(id("alice.testnet"), U128(10 * USDC), "car-1".into());
    assert!(matches!(r, PromiseOrValue::Value(U128(a)) if a == 10 * USDC));
}

#[test]
#[should_panic(expected = "only USDC is accepted")]
fn other_tokens_are_refused() {
    let mut c = listed(10 * USDC);
    at("fake-usdc.testnet", LATER, 0);
    let _ = c.ft_on_transfer(id("bob.testnet"), U128(10 * USDC), "car-1".into());
}

#[test]
fn sending_a_car_takes_it_off_sale() {
    let mut c = listed(10 * USDC);
    at("alice.testnet", LATER, 1);
    c.nft_transfer(id("bob.testnet"), "car-1".into(), None, None);
    assert_eq!(owner(&c, "car-1"), id("bob.testnet"));
    assert!(c.get_listing("car-1".into()).is_none());
    // Bob's payment now finds nothing to buy.
    at("usdc.testnet", LATER, 0);
    let r = c.ft_on_transfer(id("carol.testnet"), U128(10 * USDC), "car-1".into());
    assert!(matches!(r, PromiseOrValue::Value(U128(a)) if a == 10 * USDC));
}

#[test]
fn the_seller_can_take_it_down() {
    let mut c = listed(10 * USDC);
    at("alice.testnet", LATER, 1);
    c.delist_car("car-1".into());
    assert!(c.get_listing("car-1".into()).is_none());
}

#[test]
#[should_panic(expected = "not your listing")]
fn nobody_else_can_take_it_down() {
    let mut c = listed(10 * USDC);
    at("bob.testnet", LATER, 1);
    c.delist_car("car-1".into());
}

#[test]
#[should_panic(expected = "Approval extension is disabled")]
fn the_minter_cant_move_a_players_car() {
    let mut c = with_car();
    at("worker.testnet", LATER, 1);
    c.nft_transfer(id("worker.testnet"), "car-1".into(), None, None);
}

#[test]
#[should_panic(expected = "Approval extension is disabled")]
fn the_admin_cant_move_a_players_car() {
    let mut c = with_car();
    at("admin.testnet", LATER, 1);
    c.nft_transfer(id("admin.testnet"), "car-1".into(), None, None);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn listing_needs_the_owners_full_key() {
    let mut c = with_car();
    at("alice.testnet", LATER, 0);
    c.list_car("car-1".into(), U128(10 * USDC));
}

#[test]
fn a_failed_payout_waits_for_its_seller() {
    let mut c = listed(10 * USDC);
    at("cars.testnet", LATER, 0);
    c.on_paid(id("alice.testnet"), U128(9_500_000), Err(PromiseError::Failed));
    assert_eq!(c.owed_to(id("alice.testnet")).0, 9_500_000);
    as_caller("alice.testnet");
    let _ = c.claim();
    assert_eq!(c.owed_to(id("alice.testnet")).0, 0);
}

#[test]
#[should_panic(expected = "nothing owed")]
fn nobody_claims_what_isnt_theirs() {
    let mut c = with_car();
    as_caller("bob.testnet");
    let _ = c.claim();
}

#[test]
fn a_cut_the_dealer_refused_is_kept_for_it() {
    let mut c = contract();
    at("cars.testnet", LATER, 0);
    c.on_fee(U128(500_000), Ok(U128(0)));
    assert_eq!(c.config().fees_owed.0, 500_000);
    as_caller("anyone.testnet");
    let _ = c.pay_fees();
    assert_eq!(c.config().fees_owed.0, 0);
}

#[test]
fn the_dealer_takes_no_cut_of_its_own_sale() {
    let mut c = contract();
    as_caller("worker.testnet");
    c.mint_car("car-2".into(), id("dealer.testnet"), meta("Coupe"));
    at("dealer.testnet", LATER, 1);
    c.list_car("car-2".into(), U128(20 * USDC));
    at("usdc.testnet", LATER, 0);
    let _ = c.ft_on_transfer(id("bob.testnet"), U128(20 * USDC), "car-2".into());
    assert_eq!(owner(&c, "car-2"), id("bob.testnet"));
    assert!(get_logs().iter().any(|l| l.contains("\"fee\":\"0\"")));
}

#[test]
#[should_panic(expected = "fee is over the cap")]
fn the_cut_has_a_cap() {
    let mut c = contract();
    as_caller("admin.testnet");
    c.set_fee(1_001);
}

#[test]
#[should_panic(expected = "lock is over the cap")]
fn the_lock_has_a_cap() {
    let mut c = contract();
    as_caller("admin.testnet");
    c.set_locks(8 * DAY_NS, 0);
}

#[test]
#[should_panic(expected = "admin only")]
fn only_the_admin_sets_the_cut() {
    let mut c = contract();
    as_caller("worker.testnet");
    c.set_fee(0);
}

#[test]
fn the_wallets_see_the_cars() {
    let c = with_car();
    let mine = c.nft_tokens_for_owner(id("alice.testnet"), None, None);
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].metadata.as_ref().and_then(|m| m.title.clone()), Some("Sport".into()));
    assert_eq!(c.nft_metadata().symbol, "F33CAR");
}

#[test]
fn the_same_code_holds_homes_under_their_own_name() {
    as_caller("admin.testnet");
    let mut c = Cars::new(
        id("usdc.testnet"),
        id("admin.testnet"),
        id("worker.testnet"),
        id("dealer.testnet"),
        500,
        DAY_NS,
        DAY_NS,
        None,
        Some("fr33world homes".into()),
        Some("F33HOME".into()),
    );
    assert_eq!(c.nft_metadata().name, "fr33world homes");
    assert_eq!(c.nft_metadata().symbol, "F33HOME");
    as_caller("worker.testnet");
    c.mint_car("home-4-ab12cd".into(), id("alice.testnet"), TokenMetadata::default());
    assert_eq!(c.nft_supply_for_owner(id("alice.testnet")).0, 1);
}

fn offered() -> Cars {
    let mut c = with_car();
    at("alice.testnet", LATER, 1);
    c.offer_to_game("car-1".into());
    c
}

#[test]
fn the_game_hands_an_offered_car_to_its_dollar_buyer() {
    let mut c = offered();
    assert!(c.is_offered("car-1".into()));
    at("worker.testnet", LATER, 0);
    c.game_transfer("car-1".into(), id("bob.testnet"));
    assert_eq!(owner(&c, "car-1"), id("bob.testnet"));
    assert!(!c.is_offered("car-1".into()));
    assert_eq!(c.locked_until("car-1".into()), LATER + DAY_NS);
}

#[test]
#[should_panic(expected = "not offered to the game")]
fn the_game_cant_move_a_car_not_offered() {
    let mut c = with_car();
    at("worker.testnet", LATER, 0);
    c.game_transfer("car-1".into(), id("worker.testnet"));
}

#[test]
#[should_panic(expected = "not offered to the game")]
fn the_offer_is_good_once() {
    let mut c = offered();
    at("worker.testnet", LATER, 0);
    c.game_transfer("car-1".into(), id("bob.testnet"));
    c.game_transfer("car-1".into(), id("worker.testnet"));
}

#[test]
#[should_panic(expected = "minter only")]
fn only_the_minter_settles_a_dollar_sale() {
    let mut c = offered();
    at("bob.testnet", LATER, 0);
    c.game_transfer("car-1".into(), id("bob.testnet"));
}

#[test]
#[should_panic(expected = "not offered to the game")]
fn the_owner_can_withdraw_the_offer() {
    let mut c = offered();
    at("alice.testnet", LATER, 1);
    c.withdraw_offer("car-1".into());
    at("worker.testnet", LATER, 0);
    c.game_transfer("car-1".into(), id("bob.testnet"));
}

#[test]
fn sending_the_car_ends_the_offer() {
    let mut c = offered();
    at("alice.testnet", LATER, 1);
    c.nft_transfer(id("carol.testnet"), "car-1".into(), None, None);
    assert!(!c.is_offered("car-1".into()));
}

#[test]
fn a_usdc_sale_ends_the_dollar_offer_too() {
    let mut c = offered();
    at("alice.testnet", LATER, 1);
    c.list_car("car-1".into(), U128(10 * USDC));
    at("usdc.testnet", LATER, 0);
    let _ = c.ft_on_transfer(id("bob.testnet"), U128(10 * USDC), "car-1".into());
    assert!(!c.is_offered("car-1".into()));
}

#[test]
#[should_panic(expected = "this car is still locked")]
fn a_new_car_cant_be_offered_at_once() {
    let mut c = with_car();
    at("alice.testnet", START + DAY_NS / 2, 1);
    c.offer_to_game("car-1".into());
}
