#pragma once

#include "ExecutionCommon.h"
#include "MarketDataSnapshot.h"

#include <cstdint>
#include <string>
#include <vector>

namespace cerious::simulex {

enum class ExecutionDestination : std::uint8_t {
    Simulex,
    FixTt,
};

enum class OrderFamily : std::uint8_t {
    NativeLimit,
    NativeMarket,
    SyntheticSniper,
    SyntheticOco,
    SystemHeldStop,
    ExchangeHeldStop,
};

enum class MarketAction : std::uint8_t {
    Unknown,
    Add,
    Modify,
    Cancel,
    Trade,
    Clear,
};

struct SyntheticLegDefinition {
    std::string leg_symbol;
    std::int32_t leg_ratio = 1;
    OrderSide leg_side = OrderSide::Buy;
    double price_multiplier = 1.0;
};

struct ProductDefinitionEvent {
    std::string symbol;
    std::string venue;
    std::string product_type;
    double tick_size = 0.0;
    double multiplier = 0.0;
    double tick_value = 0.0;
    std::uint8_t display_precision = 2;
    bool is_synthetic = false;
    std::vector<SyntheticLegDefinition> legs;
};

struct MarketDataEvent {
    std::string symbol;
    std::uint64_t sequence = 0;
    std::uint64_t event_time_ns = 0;
    std::uint64_t receive_time_ns = 0;
    double bid = 0.0;
    double ask = 0.0;
    std::int32_t bid_size = 0;
    std::int32_t ask_size = 0;
    double last = 0.0;
    std::int32_t last_size = 0;
    MarketAction action = MarketAction::Unknown;
    OrderSide side = OrderSide::Buy;
    MarketDataSnapshot depth;
};

struct OrderCommand {
    std::uint64_t client_order_id = 0;
    std::string account;
    std::string operator_id;
    ExecutionDestination destination = ExecutionDestination::Simulex;
    std::string symbol;
    OrderSide side = OrderSide::Buy;
    OrderType order_type = OrderType::Limit;
    OrderFamily order_family = OrderFamily::NativeLimit;
    double price = 0.0;
    std::int32_t quantity = 0;
    std::int32_t clip_size = 0;
    std::string algo_id;
    std::string algo_name;
    std::string order_tag;
    std::uint64_t parent_order_id = 0;
    std::uint64_t created_time_ns = 0;
};

struct CancelCommand {
    std::uint64_t client_order_id = 0;
    std::string account;
    ExecutionDestination destination = ExecutionDestination::Simulex;
    std::string reason;
    std::uint64_t created_time_ns = 0;
};

struct ReplaceCommand {
    std::uint64_t client_order_id = 0;
    std::string account;
    ExecutionDestination destination = ExecutionDestination::Simulex;
    bool has_price = false;
    double price = 0.0;
    bool has_quantity = false;
    std::int32_t quantity = 0;
    std::uint64_t created_time_ns = 0;
};

struct NativeExecutionEvent {
    std::uint64_t client_order_id = 0;
    std::uint64_t exchange_order_id = 0;
    ExecutionDestination destination = ExecutionDestination::Simulex;
    std::string symbol;
    OrderSide side = OrderSide::Buy;
    ExecStatus status = ExecStatus::Accepted;
    std::int32_t fill_quantity = 0;
    std::int32_t remaining_quantity = 0;
    double limit_price = 0.0;
    double trigger_send_price = 0.0;
    double actual_fill_price = 0.0;
    std::uint64_t trigger_time_ns = 0;
    std::uint64_t execution_time_ns = 0;
    std::uint64_t latency_ns = 0;
    std::string algo_id;
    std::string algo_name;
    std::string order_tag;
    std::uint64_t parent_order_id = 0;
    std::vector<LegFillDetail> leg_details;
};

struct PositionSnapshot {
    std::string symbol;
    std::int32_t net_quantity = 0;
    double avg_price = 0.0;
    double mark_price = 0.0;
    double open_pnl = 0.0;
    double closed_pnl = 0.0;
    double total_pnl = 0.0;
    std::int32_t buy_quantity = 0;
    std::int32_t sell_quantity = 0;
    std::string session_id;
};

struct AuditEvent {
    std::uint64_t event_time_ns = 0;
    std::string severity;
    std::string source;
    std::string summary;
    std::string detail;
};

} // namespace cerious::simulex
