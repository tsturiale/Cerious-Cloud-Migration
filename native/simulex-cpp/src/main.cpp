#include "Mdp3SbeParser.h"
#include "SimulexBridgeContract.h"
#include "SimulexExchange.h"

#include <array>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <vector>

using namespace cerious::simulex;

static void require(bool condition, const char* message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

class CaptureListener final : public IExecutionListener {
public:
    std::vector<ExecutionReport> reports;

    void on_execution_report(const ExecutionReport& report) override {
        reports.push_back(report);
        std::cout << "[SIMULEX] " << report.symbol
                  << " order=" << report.client_order_id
                  << " status=" << to_string(report.status)
                  << " qty=" << report.fill_quantity
                  << " trigger=" << report.trigger_send_price
                  << " actual=" << report.actual_fill_price
                  << " legs=" << report.leg_details.size()
                  << " text=" << report.text
                  << "\n";
    }

    std::vector<ExecutionReport> fills() const {
        std::vector<ExecutionReport> out;
        for (const auto& report : reports) {
            if (report.status == ExecStatus::Filled) {
                out.push_back(report);
            }
        }
        return out;
    }
};

static RawNetworkMarketTick make_tick(
    const char* symbol,
    double bid,
    int bid_size,
    double ask,
    int ask_size,
    std::uint64_t sequence,
    std::uint64_t timestamp_ns,
    double last = 0.0,
    int last_size = 0,
    bool has_last = false
) {
    RawNetworkMarketTick tick{};
    std::snprintf(tick.symbol, sizeof(tick.symbol), "%s", symbol);
    tick.bid_prices[0] = bid;
    tick.bid_sizes[0] = bid_size;
    tick.ask_prices[0] = ask;
    tick.ask_sizes[0] = ask_size;
    tick.last_price = last;
    tick.last_size = last_size;
    tick.has_last = has_last;
    tick.levels_available = 1;
    tick.feed_sequence = sequence;
    tick.timestamp_ns = timestamp_ns;
    return tick;
}

static void validate_outright_latency_fill() {
    SimulexExchange exchange;
    CaptureListener listener;
    exchange.register_listener(&listener);
    exchange.set_latency_ns(25000);

    auto es = make_tick("ES", 3999.75, 10, 4000.00, 10, 1000, 1000000);
    exchange.on_market_update("ES", MarketDataConverter::convert_to_simulex_snapshot(es), 1000000);

    exchange.send_order(OrderRequest{1001, "ES", OrderSide::Buy, OrderType::Limit, 4000.00, 2, 0.0, 1001});
    require(exchange.resting_order_count() == 0, "outright marketable order should enter flight immediately");

    es.ask_prices[0] = 4000.50;
    exchange.on_market_update("ES", MarketDataConverter::convert_to_simulex_snapshot(es), 1010000);
    exchange.on_market_update("ES", MarketDataConverter::convert_to_simulex_snapshot(es), 1030000);

    const auto fills = listener.fills();
    require(fills.size() == 1, "outright latency fill missing");
    require(fills[0].trigger_send_price == 4000.00, "outright trigger price mismatch");
    require(fills[0].actual_fill_price == 4000.50, "outright actual fill price mismatch");
    require(fills[0].leg_details.size() == 1, "outright fill should have one leg detail");
}

static void validate_last_trade_through_fill() {
    SimulexExchange exchange;
    CaptureListener listener;
    exchange.register_listener(&listener);
    exchange.set_latency_ns(25000);

    auto es = make_tick("ES", 3999.75, 10, 4000.00, 10, 1100, 1000000);
    exchange.on_market_update("ES", MarketDataConverter::convert_to_simulex_snapshot(es), 1000000);

    exchange.send_order(OrderRequest{1101, "ES", OrderSide::Sell, OrderType::Limit, 4001.00, 1, 0.0, 1101});
    require(exchange.resting_order_count() == 1, "trade-through test order should initially rest");

    es = make_tick("ES", 3999.75, 10, 4000.25, 10, 1102, 1010000, 4001.25, 1, true);
    exchange.on_market_update("ES", MarketDataConverter::convert_to_simulex_snapshot(es), 1010000);
    require(exchange.resting_order_count() == 0, "last trade-through should remove order from resting book");
    exchange.advance_time(1035000);

    const auto fills = listener.fills();
    require(fills.size() == 1, "last trade-through fill missing");
    require(fills[0].trigger_send_price == 4001.25, "last trade-through trigger price mismatch");
    require(fills[0].actual_fill_price == 4001.25, "last trade-through actual price mismatch");
}

static void validate_fifo_replace_rules() {
    SimulexExchange exchange;
    CaptureListener listener;
    exchange.register_listener(&listener);

    exchange.send_order(OrderRequest{2001, "ES", OrderSide::Buy, OrderType::Limit, 3999.00, 5, 0.0, 10});
    exchange.send_order(OrderRequest{2002, "ES", OrderSide::Buy, OrderType::Limit, 3999.00, 5, 0.0, 11});
    const auto original_priority = exchange.order_priority(2001);

    exchange.replace_order(2001, ReplaceRequest{std::nullopt, 3, 12});
    require(exchange.order_priority(2001) == original_priority, "quantity reduction should preserve FIFO priority");

    exchange.replace_order(2001, ReplaceRequest{std::nullopt, 6, 13});
    require(exchange.order_priority(2001) > exchange.order_priority(2002), "quantity increase should lose FIFO priority");

    exchange.replace_order(2002, ReplaceRequest{3998.75, std::nullopt, 14});
    require(exchange.order_priority(2002) > original_priority, "price change should lose FIFO priority");
}

static void validate_synthetic_spread_fill() {
    SimulexExchange exchange;
    CaptureListener listener;
    exchange.register_listener(&listener);
    exchange.set_latency_ns(25000);
    exchange.register_spread("ES_NQ", SpreadDefinition{"ES", "NQ", 3, 2, 0.2666667});

    auto es = make_tick("ES", 3999.75, 20, 4000.00, 20, 2000, 1000000);
    auto nq = make_tick("NQ", 14999.00, 20, 15000.00, 20, 2001, 1000000);
    exchange.on_market_update("ES", MarketDataConverter::convert_to_simulex_snapshot(es), 1000000);
    exchange.on_market_update("NQ", MarketDataConverter::convert_to_simulex_snapshot(nq), 1000000);

    exchange.send_order(OrderRequest{3001, "ES_NQ", OrderSide::Buy, OrderType::Sniper, 0.0, 1, 1.00, 2002});
    es.ask_prices[0] = 4000.50;
    exchange.on_market_update("ES", MarketDataConverter::convert_to_simulex_snapshot(es), 1010000);
    exchange.on_market_update("ES", MarketDataConverter::convert_to_simulex_snapshot(es), 1030000);

    const auto fills = listener.fills();
    require(!fills.empty(), "synthetic spread fill missing");
    const auto& fill = fills.back();
    require(fill.symbol == "ES_NQ", "synthetic fill symbol mismatch");
    require(fill.leg_details.size() == 2, "synthetic fill should have two leg details");
    require(fill.leg_details[0].leg_symbol == "ES", "synthetic left leg symbol mismatch");
    require(fill.leg_details[0].leg_fill_quantity == 3, "synthetic left leg quantity mismatch");
    require(fill.leg_details[1].leg_symbol == "NQ", "synthetic right leg symbol mismatch");
    require(fill.leg_details[1].leg_fill_quantity == 2, "synthetic right leg quantity mismatch");
}

static void validate_sbe_parser_bounds() {
    std::array<std::uint8_t, 512> raw{};
    auto* packet = reinterpret_cast<Mdp3PacketHeader*>(raw.data());
    packet->msg_seq_num = 500123;
    packet->sending_time = 1718800000000000000ULL;

    auto* header = reinterpret_cast<SbeMessageHeader*>(raw.data() + sizeof(Mdp3PacketHeader));
    header->template_id = 32;
    header->block_length = sizeof(MdIncrementalEntry);

    auto* group = reinterpret_cast<SbeGroupHeader*>(raw.data() + sizeof(Mdp3PacketHeader) + sizeof(SbeMessageHeader));
    group->block_length = sizeof(MdIncrementalEntry);
    group->num_in_group = 2;

    auto* entry1 = reinterpret_cast<MdIncrementalEntry*>(raw.data() + sizeof(Mdp3PacketHeader) + sizeof(SbeMessageHeader) + sizeof(SbeGroupHeader));
    entry1->order_id = 99001;
    entry1->md_entry_px = 10050;
    entry1->md_entry_size = 10;
    entry1->md_update_action = 0;
    entry1->md_entry_type = 1;

    auto* entry2 = entry1 + 1;
    entry2->order_id = 99002;
    entry2->md_entry_px = 10050;
    entry2->md_entry_size = 5;
    entry2->md_update_action = 0;
    entry2->md_entry_type = 1;

    const auto packet_size = sizeof(Mdp3PacketHeader) + sizeof(SbeMessageHeader) + sizeof(SbeGroupHeader) + (2 * sizeof(MdIncrementalEntry));
    const auto entries = Mdp3SbeParser::parse_incremental_book_packet(raw.data(), packet_size);
    require(entries.size() == 2, "SBE parser entry count mismatch");
    require(entries[0].packet_sequence == 500123, "SBE parser packet sequence mismatch");
    require(entries[0].entry.order_id == 99001, "SBE parser first order id mismatch");
}

int main() {
    try {
        validate_outright_latency_fill();
        validate_last_trade_through_fill();
        validate_fifo_replace_rules();
        validate_synthetic_spread_fill();
        validate_sbe_parser_bounds();

        std::cout << "\nSIMULEX validation passed.\n";
        return 0;
    } catch (const std::exception& exc) {
        std::cerr << "SIMULEX validation failed: " << exc.what() << "\n";
        return 1;
    }
}
