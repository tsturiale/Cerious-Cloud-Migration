#include "DeterministicExchange.hpp"

#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>

using namespace cerious::exchange;

namespace {

bool has_status(const std::vector<ExecutionReport>& reports, const std::string& order_id, ExecStatus status) {
    for (const auto& report : reports) {
        if (report.order_id == order_id && report.status == status) return true;
    }
    return false;
}

bool has_delta(const GatewayEventBatch& batch, const std::string& symbol, Side side, BookDeltaAction action, double price) {
    for (const auto& delta : batch.book_deltas) {
        if (delta.symbol == symbol && delta.side == side && delta.action == action && std::abs(delta.price - price) < 0.00001) {
            return true;
        }
    }
    return false;
}

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

OrderCommand limit_order(std::string id, std::string symbol, Side side, double price, Quantity qty, Milliseconds ts = 1000) {
    OrderCommand command;
    command.order_id = std::move(id);
    command.symbol = std::move(symbol);
    command.side = side;
    command.type = OrderType::Limit;
    command.price = price;
    command.quantity = qty;
    command.timestamp_ms = ts;
    command.metadata.source = "sandbox";
    command.metadata.order_tag = "TEST";
    return command;
}

void test_incoming_cross_fifo() {
    DeterministicExchange exchange;
    exchange.register_products(DeterministicExchange::starter_products());

    auto a = exchange.submit_order(limit_order("B1", "ES", Side::Buy, 5000.25, 1, 1000));
    auto b = exchange.submit_order(limit_order("B2", "ES", Side::Buy, 5000.25, 1, 1000));
    require(has_status(a, "B1", ExecStatus::Resting), "B1 should rest");
    require(has_status(b, "B2", ExecStatus::Resting), "B2 should rest");

    auto s = exchange.submit_order(limit_order("S1", "ES", Side::Sell, 5000.25, 2, 1001));
    require(has_status(s, "S1", ExecStatus::Filled), "S1 should fill");
    require(has_status(s, "B1", ExecStatus::Filled), "B1 should fill first");
    require(has_status(s, "B2", ExecStatus::Filled), "B2 should fill second");

    auto snap = exchange.snapshot("ES");
    require(snap.bids.empty(), "ES bids should be empty after cross");
    require(snap.asks.empty(), "ES asks should be empty after cross");
}

void test_resting_buy_fills_when_market_trades_through() {
    DeterministicExchange exchange;
    exchange.register_products(DeterministicExchange::starter_products());

    auto resting = exchange.submit_order_batch(limit_order("BUY_RTY_ES", "RTY_ES", Side::Buy, -608.50, 3, 2000));
    require(has_status(resting.reports, "BUY_RTY_ES", ExecStatus::Resting), "negative spread bid should rest");
    require(has_delta(resting, "RTY_ES", Side::Buy, BookDeltaAction::Add, -608.50), "resting spread bid should emit add delta");

    MarketDataTick tick;
    tick.symbol = "RTY_ES";
    tick.last = -608.75;
    tick.last_size = 10;
    tick.timestamp_ms = 2001;
    auto fills = exchange.apply_market_data_batch(tick);
    require(has_status(fills.reports, "BUY_RTY_ES", ExecStatus::Filled), "resting spread bid should fill when market trades through");
    require(has_delta(fills, "RTY_ES", Side::Buy, BookDeltaAction::Delete, -608.50), "filled spread bid should emit delete delta");
    require(exchange.snapshot("RTY_ES").bids.empty(), "RTY_ES bid book should be empty after market fill");
}

void test_resting_sell_fills_when_market_trades_through() {
    DeterministicExchange exchange;
    exchange.register_products(DeterministicExchange::starter_products());

    auto resting = exchange.submit_order(limit_order("SELL_YM_ES", "YM_ES", Side::Sell, 1900.0, 4, 3000));
    require(has_status(resting, "SELL_YM_ES", ExecStatus::Resting), "YM_ES offer should rest");

    MarketDataTick tick;
    tick.symbol = "YM_ES";
    tick.last = 1901.0;
    tick.last_size = 10;
    tick.timestamp_ms = 3001;
    auto fills = exchange.apply_market_data(tick);
    require(has_status(fills, "SELL_YM_ES", ExecStatus::Filled), "resting offer should fill when market trades through");
    require(exchange.snapshot("YM_ES").asks.empty(), "YM_ES ask book should be empty after market fill");
}

void test_cancel_and_duplicate_reject() {
    DeterministicExchange exchange;
    exchange.register_products(DeterministicExchange::starter_products());

    auto resting = exchange.submit_order(limit_order("NQ_BID", "NQ", Side::Buy, 20250.25, 2, 4000));
    require(has_status(resting, "NQ_BID", ExecStatus::Resting), "NQ_BID should rest");

    auto duplicate = exchange.submit_order(limit_order("NQ_BID", "NQ", Side::Buy, 20250.25, 2, 4001));
    require(has_status(duplicate, "NQ_BID", ExecStatus::Rejected), "duplicate order id should reject");

    CancelCommand cancel;
    cancel.order_id = "NQ_BID";
    cancel.timestamp_ms = 4002;
    auto canceled = exchange.cancel_order(cancel);
    require(has_status(canceled, "NQ_BID", ExecStatus::Canceled), "NQ_BID should cancel");
    require(exchange.snapshot("NQ").bids.empty(), "NQ bid book should be empty after cancel");
}

void test_custom_future_product_registration() {
    DeterministicExchange exchange;
    exchange.register_products(DeterministicExchange::starter_products());
    exchange.register_product({"CUSTOM_FUT", "TEST", 0.5, 100.0, 1, false});
    auto reports = exchange.submit_order(limit_order("CUSTOM_1", "CUSTOM_FUT", Side::Sell, 101.5, 7, 5000));
    require(has_status(reports, "CUSTOM_1", ExecStatus::Resting), "custom future should rest");
    const auto snap = exchange.snapshot("CUSTOM_FUT");
    require(snap.asks.size() == 1, "custom future should have one ask level");
    require(snap.asks[0].aggregate_quantity == 7, "custom future ask qty should be 7");
}

} // namespace

int main() {
    test_incoming_cross_fifo();
    test_resting_buy_fills_when_market_trades_through();
    test_resting_sell_fills_when_market_trades_through();
    test_cancel_and_duplicate_reject();
    test_custom_future_product_registration();
    std::cout << "cerious_exchange_sandbox: all deterministic matching checks passed\n";
    return 0;
}
