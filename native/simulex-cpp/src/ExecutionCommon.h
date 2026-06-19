#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace cerious::simulex {

enum class OrderSide : std::uint8_t { Buy, Sell };
enum class OrderType : std::uint8_t { Limit, Market, Sniper };
enum class ExecStatus : std::uint8_t { Accepted, Filled, Partial, Rejected, Canceled, Replaced };

struct OrderRequest {
    std::uint64_t client_order_id = 0;
    std::string symbol;
    OrderSide side = OrderSide::Buy;
    OrderType type = OrderType::Limit;
    double price = 0.0;
    std::int32_t quantity = 0;
    double target_spread_price = 0.0;
    std::uint64_t sequence = 0;
};

struct LegFillDetail {
    std::string leg_symbol;
    OrderSide leg_side = OrderSide::Buy;
    double leg_fill_price = 0.0;
    std::int32_t leg_fill_quantity = 0;
};

struct ExecutionReport {
    std::uint64_t client_order_id = 0;
    std::uint64_t exchange_order_id = 0;
    std::string symbol;
    ExecStatus status = ExecStatus::Accepted;
    double trigger_send_price = 0.0;
    double actual_fill_price = 0.0;
    std::int32_t fill_quantity = 0;
    std::uint64_t trigger_timestamp_ns = 0;
    std::uint64_t execution_timestamp_ns = 0;
    std::vector<LegFillDetail> leg_details;
    std::string text;
};

class IExecutionListener {
public:
    virtual ~IExecutionListener() = default;
    virtual void on_execution_report(const ExecutionReport& report) = 0;
};

class IExecutionGateway {
protected:
    IExecutionListener* listener_ = nullptr;

public:
    virtual ~IExecutionGateway() = default;

    void register_listener(IExecutionListener* listener) {
        listener_ = listener;
    }

    virtual void send_order(const OrderRequest& request) = 0;
    virtual void cancel_order(std::uint64_t client_order_id) = 0;
};

inline const char* to_string(OrderSide side) {
    return side == OrderSide::Buy ? "BUY" : "SELL";
}

inline const char* to_string(ExecStatus status) {
    switch (status) {
        case ExecStatus::Accepted: return "ACCEPTED";
        case ExecStatus::Filled: return "FILLED";
        case ExecStatus::Partial: return "PARTIAL";
        case ExecStatus::Rejected: return "REJECTED";
        case ExecStatus::Canceled: return "CANCELED";
        case ExecStatus::Replaced: return "REPLACED";
    }
    return "UNKNOWN";
}

} // namespace cerious::simulex
