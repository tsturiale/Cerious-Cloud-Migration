#include "DeterministicExchange.hpp"

#include <httplib.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <deque>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>

using namespace cerious::exchange;

namespace {

std::string get_string(const std::string& json, const std::string& key, const std::string& fallback = "") {
    const auto pattern = "\"" + key + "\"";
    auto pos = json.find(pattern);
    if (pos == std::string::npos) return fallback;
    pos = json.find(':', pos + pattern.size());
    if (pos == std::string::npos) return fallback;
    ++pos;
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) ++pos;
    if (pos >= json.size()) return fallback;
    if (json[pos] != '"') {
        auto end = pos;
        while (end < json.size() && json[end] != ',' && json[end] != '}') ++end;
        auto raw = json.substr(pos, end - pos);
        raw.erase(raw.find_last_not_of(" \t\r\n") + 1);
        raw.erase(0, raw.find_first_not_of(" \t\r\n"));
        return raw.empty() ? fallback : raw;
    }
    ++pos;
    std::string out;
    while (pos < json.size()) {
        const char ch = json[pos++];
        if (ch == '"') break;
        if (ch == '\\' && pos < json.size()) {
            const char escaped = json[pos++];
            switch (escaped) {
                case '"': out.push_back('"'); break;
                case '\\': out.push_back('\\'); break;
                case 'n': out.push_back('\n'); break;
                case 'r': out.push_back('\r'); break;
                case 't': out.push_back('\t'); break;
                default: out.push_back(escaped); break;
            }
        } else {
            out.push_back(ch);
        }
    }
    return out.empty() ? fallback : out;
}

double get_double(const std::string& json, const std::string& key, double fallback = 0.0) {
    const auto raw = get_string(json, key, "");
    if (raw.empty()) return fallback;
    try { return std::stod(raw); } catch (...) { return fallback; }
}

int get_int(const std::string& json, const std::string& key, int fallback = 0) {
    return static_cast<int>(std::llround(get_double(json, key, static_cast<double>(fallback))));
}

Milliseconds get_ms(const std::string& json, const std::string& key, Milliseconds fallback = 0) {
    const auto raw = get_string(json, key, "");
    if (raw.empty()) return fallback;
    try { return static_cast<Milliseconds>(std::stoull(raw)); } catch (...) { return fallback; }
}

Side parse_side(std::string raw) {
    std::transform(raw.begin(), raw.end(), raw.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    return raw == "sell" || raw == "offer" || raw == "ask" || raw == "s" ? Side::Sell : Side::Buy;
}

OrderType parse_type(std::string raw) {
    std::transform(raw.begin(), raw.end(), raw.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    return raw == "market" ? OrderType::Market : OrderType::Limit;
}

TimeInForce parse_tif(std::string raw) {
    std::transform(raw.begin(), raw.end(), raw.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    if (raw == "ioc") return TimeInForce::Ioc;
    if (raw == "gtc") return TimeInForce::Gtc;
    return TimeInForce::Day;
}

std::string env_string(const char* name) {
#ifdef _WIN32
    char* buffer = nullptr;
    std::size_t size = 0;
    if (_dupenv_s(&buffer, &size, name) == 0 && buffer != nullptr) {
        std::string value(buffer);
        std::free(buffer);
        return value;
    }
    return "";
#else
    const auto* value = std::getenv(name);
    return value == nullptr ? std::string{} : std::string(value);
#endif
}

void send_json(httplib::Response& res, const std::string& body, int status = 200) {
    res.status = status;
    res.set_header("Cache-Control", "no-store");
    res.set_content(body, "application/json");
}

OrderCommand parse_order(const std::string& body) {
    OrderCommand command;
    command.order_id = get_string(body, "orderId", get_string(body, "order_id"));
    command.symbol = get_string(body, "symbol", get_string(body, "marketKey"));
    command.side = parse_side(get_string(body, "side", "buy"));
    command.type = parse_type(get_string(body, "type", get_string(body, "orderType", "limit")));
    command.tif = parse_tif(get_string(body, "timeInForce", get_string(body, "tif", "day")));
    command.price = get_double(body, "price", 0.0);
    command.quantity = get_int(body, "quantity", get_int(body, "size", 0));
    command.timestamp_ms = get_ms(body, "timestampMs", 0);
    command.metadata.account = get_string(body, "account");
    command.metadata.operator_id = get_string(body, "operatorId");
    command.metadata.source = get_string(body, "source", "manual");
    command.metadata.strategy = get_string(body, "strategy", "manual");
    command.metadata.algo_id = get_string(body, "algoId");
    command.metadata.algo_name = get_string(body, "algoName");
    command.metadata.algo_role = get_string(body, "algoRole");
    command.metadata.order_tag = get_string(body, "orderTag", command.metadata.algo_id.empty() ? "MANUAL" : "ALGO");
    command.metadata.parent_order_id = get_string(body, "parentOrderId");
    command.metadata.trigger = get_string(body, "trigger");
    command.metadata.layer = get_int(body, "layer", 0);
    return command;
}

MarketDataTick parse_market(const std::string& body) {
    MarketDataTick tick;
    tick.symbol = get_string(body, "symbol", get_string(body, "marketKey"));
    if (!get_string(body, "bestBid").empty()) tick.best_bid = get_double(body, "bestBid");
    else if (!get_string(body, "bid").empty()) tick.best_bid = get_double(body, "bid");
    if (!get_string(body, "bestAsk").empty()) tick.best_ask = get_double(body, "bestAsk");
    else if (!get_string(body, "ask").empty()) tick.best_ask = get_double(body, "ask");
    if (!get_string(body, "last").empty()) tick.last = get_double(body, "last");
    tick.last_size = get_int(body, "lastSize", 0);
    tick.timestamp_ms = get_ms(body, "timestampMs", 0);
    if (tick.timestamp_ms == 0) {
        const auto timestamp_ns = get_ms(body, "timestampNs", 0);
        if (timestamp_ns > 0) tick.timestamp_ms = timestamp_ns / 1000000ULL;
    }
    return tick;
}

std::string status_string(ExecStatus status) {
    switch (status) {
        case ExecStatus::Accepted: return "accepted";
        case ExecStatus::Resting: return "working";
        case ExecStatus::PartialFill: return "partial";
        case ExecStatus::Filled: return "filled";
        case ExecStatus::Canceled: return "cancelled";
        case ExecStatus::Rejected: return "rejected";
        case ExecStatus::Replaced: return "replaced";
    }
    return "unknown";
}

std::string side_token(Side side) {
    return side == Side::Buy ? "bid" : "offer";
}

std::string display_side(Side side) {
    return side == Side::Buy ? "BUY" : "SELL";
}

double finite_or_zero(double value) {
    return std::isfinite(value) ? value : 0.0;
}

class ExchangeServerState {
public:
    ExchangeServerState() {
        exchange_.register_products(DeterministicExchange::starter_products());
        for (const auto& product : exchange_.products()) {
            products_[product.symbol] = product;
        }
    }

    std::string health_json() const {
        return "{\"ok\":true,\"service\":\"cerious.exchange\",\"runtime\":\"cpp\",\"products\":" + std::to_string(products_.size()) + "}";
    }

    std::string products_json() const {
        return ExchangeJson::products(exchange_.products());
    }

    std::string send_order(const std::string& body) {
        const auto batch = exchange_.submit_order_batch(parse_order(body));
        apply_batch(batch);
        return ExchangeJson::event_batch(batch);
    }

    std::string cancel_order(const std::string& body) {
        CancelCommand command;
        command.order_id = get_string(body, "orderId", get_string(body, "order_id"));
        command.reason = get_string(body, "reason", "user_cancel");
        command.timestamp_ms = get_ms(body, "timestampMs", 0);
        const auto batch = exchange_.cancel_order_batch(command);
        apply_batch(batch);
        return ExchangeJson::event_batch(batch);
    }

    std::string replace_order(const std::string& body) {
        ReplaceCommand command;
        command.order_id = get_string(body, "orderId", get_string(body, "order_id"));
        if (!get_string(body, "price").empty()) command.price = get_double(body, "price");
        if (!get_string(body, "quantity").empty()) command.quantity = get_int(body, "quantity");
        command.timestamp_ms = get_ms(body, "timestampMs", 0);
        const auto batch = exchange_.replace_order_batch(command);
        apply_batch(batch);
        return ExchangeJson::event_batch(batch);
    }

    std::string apply_market(const std::string& body) {
        const auto tick = parse_market(body);
        update_mark(tick);
        const auto batch = exchange_.apply_market_data_batch(tick);
        apply_batch(batch);
        return ExchangeJson::event_batch(batch);
    }

    std::string snapshot_json(const std::string& symbol, std::size_t levels) const {
        return ExchangeJson::snapshot(exchange_.snapshot(symbol, levels));
    }

    std::string orders_json() const {
        return ExchangeJson::working_orders(exchange_);
    }

    std::string state_json() const {
        std::ostringstream out;
        out << "{\"service\":\"cerious.exchange\""
            << ",\"fetchedAt\":" << current_ms()
            << ",\"simOrders\":" << working_orders_json()
            << ",\"simPositions\":" << positions_json()
            << ",\"fills\":" << fills_json()
            << ",\"simMessages\":[";
        for (std::size_t i = 0; i < messages_.size(); ++i) {
            if (i) out << ",";
            out << ExchangeJson::q(messages_[i]);
        }
        out << "]}";
        return out.str();
    }

    void reset(bool clear_fills) {
        exchange_.reset();
        messages_.push_front(clear_fills ? "Cerious Exchange reset: orders, fills, and positions cleared." : "Cerious Exchange reset: working orders cleared.");
        while (messages_.size() > 50) messages_.pop_back();
        if (clear_fills) {
            fills_.clear();
            positions_.clear();
        }
    }

private:
    struct FillState {
        std::string id;
        std::string order_id;
        std::string symbol;
        Side side = Side::Buy;
        int qty = 0;
        double price = 0.0;
        Milliseconds timestamp_ms = 0;
        OrderMetadata metadata;
    };

    struct PositionState {
        std::string symbol;
        int qty = 0;
        int buy_qty = 0;
        int sell_qty = 0;
        double avg_price = 0.0;
        double mark_price = 0.0;
        double open_pnl = 0.0;
        double realized_pnl = 0.0;
    };

    DeterministicExchange exchange_;
    std::unordered_map<std::string, ProductSpec> products_;
    std::unordered_map<std::string, double> marks_;
    std::map<std::string, PositionState> positions_;
    std::vector<FillState> fills_;
    std::deque<std::string> messages_;

    static Milliseconds current_ms() {
        return static_cast<Milliseconds>(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count());
    }

    const ProductSpec& product(const std::string& symbol) const {
        static const ProductSpec fallback{"UNKNOWN", "SIM", 0.25, 1.0, 2, false};
        const auto it = products_.find(symbol);
        return it == products_.end() ? fallback : it->second;
    }

    double order_price(const Order& order) const {
        return static_cast<double>(order.price_ticks) * product(order.symbol).tick_size;
    }

    void update_mark(const MarketDataTick& tick) {
        double mark = std::nan("");
        if (tick.last) mark = *tick.last;
        else if (tick.best_bid && tick.best_ask) mark = (*tick.best_bid + *tick.best_ask) / 2.0;
        else if (tick.best_bid) mark = *tick.best_bid;
        else if (tick.best_ask) mark = *tick.best_ask;
        if (!std::isfinite(mark)) return;
        marks_[tick.symbol] = mark;
        auto pos_it = positions_.find(tick.symbol);
        if (pos_it != positions_.end()) {
            pos_it->second.mark_price = mark;
            recalc_open_pnl(pos_it->second);
        }
    }

    void apply_batch(const GatewayEventBatch& batch) {
        for (const auto& report : batch.reports) {
            if (report.fill_quantity <= 0) continue;
            record_fill(report);
        }
    }

    void record_fill(const ExecutionReport& report) {
        FillState fill;
        fill.id = "CERX-FILL-" + std::to_string(report.sequence);
        fill.order_id = report.order_id;
        fill.symbol = report.symbol;
        fill.side = report.side;
        fill.qty = report.fill_quantity;
        fill.price = report.execution_price;
        fill.timestamp_ms = report.timestamp_ms ? report.timestamp_ms : current_ms();
        fill.metadata = report.metadata;
        fills_.push_back(fill);
        if (fills_.size() > 5000) {
            fills_.erase(fills_.begin(), fills_.begin() + static_cast<std::ptrdiff_t>(fills_.size() - 5000));
        }
        update_position(fill);
    }

    void update_position(const FillState& fill) {
        auto& pos = positions_[fill.symbol];
        pos.symbol = fill.symbol;
        if (fill.side == Side::Buy) pos.buy_qty += fill.qty;
        else pos.sell_qty += fill.qty;

        const int signed_qty = fill.side == Side::Buy ? fill.qty : -fill.qty;
        if (pos.qty == 0 || (pos.qty > 0) == (signed_qty > 0)) {
            const int next_qty = pos.qty + signed_qty;
            pos.avg_price = next_qty == 0
                ? 0.0
                : ((pos.avg_price * std::abs(pos.qty)) + (fill.price * fill.qty)) / std::abs(next_qty);
            pos.qty = next_qty;
        } else {
            const int closing_qty = std::min(std::abs(pos.qty), std::abs(signed_qty));
            const double direction = pos.qty > 0 ? 1.0 : -1.0;
            pos.realized_pnl += static_cast<double>(closing_qty) * (fill.price - pos.avg_price) * direction * product(fill.symbol).multiplier;
            const int remaining = pos.qty + signed_qty;
            if (remaining == 0) {
                pos.qty = 0;
                pos.avg_price = 0.0;
            } else if ((remaining > 0) == (pos.qty > 0)) {
                pos.qty = remaining;
            } else {
                pos.qty = remaining;
                pos.avg_price = fill.price;
            }
        }
        const auto mark_it = marks_.find(fill.symbol);
        pos.mark_price = mark_it == marks_.end() ? fill.price : mark_it->second;
        recalc_open_pnl(pos);
    }

    void recalc_open_pnl(PositionState& pos) const {
        pos.open_pnl = (pos.mark_price - pos.avg_price) * static_cast<double>(pos.qty) * product(pos.symbol).multiplier;
    }

    std::string working_orders_json() const {
        const auto orders = exchange_.working_orders();
        std::ostringstream out;
        out << "[";
        for (std::size_t i = 0; i < orders.size(); ++i) {
            if (i) out << ",";
            const auto& order = orders[i];
            const auto& spec = product(order.symbol);
            out << "{\"id\":" << ExchangeJson::q(order.id)
                << ",\"marketKey\":" << ExchangeJson::q(order.symbol)
                << ",\"outcome\":\"yes\""
                << ",\"side\":" << ExchangeJson::q(side_token(order.side))
                << ",\"orderType\":" << ExchangeJson::q(order.type == OrderType::Market ? "market" : "limit")
                << ",\"price\":" << order_price(order)
                << ",\"size\":" << order.original_quantity
                << ",\"remaining\":" << order.remaining_quantity
                << ",\"filledSize\":" << (order.original_quantity - order.remaining_quantity)
                << ",\"matchedVolume\":" << (order.original_quantity - order.remaining_quantity)
                << ",\"status\":\"working\""
                << ",\"createdAt\":" << order.timestamp_ms
                << ",\"updatedAt\":" << order.timestamp_ms
                << ",\"operator\":\"tsturiale\""
                << ",\"source\":" << ExchangeJson::q(order.metadata.source)
                << ",\"strategy\":" << ExchangeJson::q(order.metadata.strategy)
                << ",\"legId\":" << ExchangeJson::q(order.id + "-L1")
                << ",\"orderTag\":" << ExchangeJson::q(order.metadata.order_tag)
                << ",\"algoRole\":" << ExchangeJson::q(order.metadata.algo_role)
                << ",\"algoId\":" << ExchangeJson::q(order.metadata.algo_id)
                << ",\"algoName\":" << ExchangeJson::q(order.metadata.algo_name)
                << ",\"parentOrderId\":" << ExchangeJson::q(order.metadata.parent_order_id)
                << ",\"layer\":" << order.metadata.layer
                << ",\"trigger\":" << ExchangeJson::q(order.metadata.trigger)
                << ",\"tickSize\":" << spec.tick_size
                << ",\"tickValue\":" << (spec.tick_size * spec.multiplier)
                << ",\"multiplier\":" << spec.multiplier
                << "}";
        }
        out << "]";
        return out.str();
    }

    std::string fills_json() const {
        std::map<std::string, std::vector<const FillState*>> by_symbol;
        for (const auto& fill : fills_) by_symbol[fill.symbol].push_back(&fill);
        std::ostringstream out;
        out << "{";
        bool first_symbol = true;
        for (const auto& [symbol, rows] : by_symbol) {
            if (!first_symbol) out << ",";
            first_symbol = false;
            out << ExchangeJson::q(symbol) << ":[";
            const auto start = rows.size() > 250 ? rows.size() - 250 : 0U;
            for (std::size_t i = start; i < rows.size(); ++i) {
                if (i > start) out << ",";
                const auto& fill = *rows[i];
                out << "{\"timestamp\":" << fill.timestamp_ms
                    << ",\"marketKey\":" << ExchangeJson::q(fill.symbol)
                    << ",\"price\":" << fill.price
                    << ",\"size\":" << fill.qty
                    << ",\"side\":" << ExchangeJson::q(fill.side == Side::Buy ? "yes" : "no")
                    << ",\"displaySide\":" << ExchangeJson::q(display_side(fill.side))
                    << ",\"orderId\":" << ExchangeJson::q(fill.order_id)
                    << ",\"source\":" << ExchangeJson::q(fill.metadata.source)
                    << ",\"strategy\":" << ExchangeJson::q(fill.metadata.strategy)
                    << ",\"orderTag\":" << ExchangeJson::q(fill.metadata.order_tag)
                    << ",\"algoRole\":" << ExchangeJson::q(fill.metadata.algo_role)
                    << "}";
            }
            out << "]";
        }
        out << "}";
        return out.str();
    }

    std::string positions_json() const {
        std::ostringstream out;
        out << "[";
        bool first = true;
        for (const auto& [symbol, pos] : positions_) {
            if (pos.qty == 0 && pos.realized_pnl == 0.0) continue;
            if (!first) out << ",";
            first = false;
            const auto& spec = product(symbol);
            out << "{\"id\":" << ExchangeJson::q("cerx-pos-" + symbol)
                << ",\"marketKey\":" << ExchangeJson::q(symbol)
                << ",\"outcome\":" << ExchangeJson::q(pos.qty >= 0 ? "yes" : "no")
                << ",\"size\":" << pos.qty
                << ",\"avgPrice\":" << finite_or_zero(pos.avg_price)
                << ",\"markPrice\":" << finite_or_zero(pos.mark_price)
                << ",\"openPnl\":" << finite_or_zero(pos.open_pnl)
                << ",\"realizedPnl\":" << finite_or_zero(pos.realized_pnl)
                << ",\"totalPnl\":" << finite_or_zero(pos.open_pnl + pos.realized_pnl)
                << ",\"status\":\"open\""
                << ",\"openedAt\":0"
                << ",\"operator\":\"tsturiale\""
                << ",\"source\":\"cerious-exchange\""
                << ",\"strategy\":\"native-ledger\""
                << ",\"legId\":" << ExchangeJson::q(symbol + "-cerx-position")
                << ",\"tickSize\":" << spec.tick_size
                << ",\"tickValue\":" << (spec.tick_size * spec.multiplier)
                << ",\"multiplier\":" << spec.multiplier
                << "}";
        }
        out << "]";
        return out.str();
    }
};

} // namespace

int main(int argc, char** argv) {
    int port = 8011;
    const auto env_port = env_string("CERIOUS_EXCHANGE_PORT");
    if (!env_port.empty()) {
        try { port = std::stoi(env_port); } catch (...) {}
    } else {
        const auto compat_port = env_string("CERIOUS_EXCHANGE_HTTP_PORT");
        if (!compat_port.empty()) {
            try { port = std::stoi(compat_port); } catch (...) {}
        } else {
            const auto old_port = env_string("SIMULEX_HTTP_PORT");
            if (!old_port.empty()) {
                try { port = std::stoi(old_port); } catch (...) {}
            }
        }
    }
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--port" && i + 1 < argc) {
            try { port = std::stoi(argv[++i]); } catch (...) {}
        }
    }

    ExchangeServerState state;
    std::mutex mutex;
    std::atomic_bool shutdown_requested{false};

    httplib::Server server;

    server.Get("/health", [&](const httplib::Request&, httplib::Response& res) {
        std::lock_guard<std::mutex> lock(mutex);
        send_json(res, state.health_json());
    });

    server.Get("/products", [&](const httplib::Request&, httplib::Response& res) {
        std::lock_guard<std::mutex> lock(mutex);
        send_json(res, state.products_json());
    });

    server.Post("/send", [&](const httplib::Request& req, httplib::Response& res) {
        std::lock_guard<std::mutex> lock(mutex);
        send_json(res, state.send_order(req.body));
    });

    server.Post("/cancel", [&](const httplib::Request& req, httplib::Response& res) {
        std::lock_guard<std::mutex> lock(mutex);
        send_json(res, state.cancel_order(req.body));
    });

    server.Post("/replace", [&](const httplib::Request& req, httplib::Response& res) {
        std::lock_guard<std::mutex> lock(mutex);
        send_json(res, state.replace_order(req.body));
    });

    server.Post("/market", [&](const httplib::Request& req, httplib::Response& res) {
        std::lock_guard<std::mutex> lock(mutex);
        send_json(res, state.apply_market(req.body));
    });

    server.Get(R"(/book/([^/]+))", [&](const httplib::Request& req, httplib::Response& res) {
        std::size_t levels = 20;
        if (req.has_param("levels")) {
            try { levels = static_cast<std::size_t>(std::clamp(std::stoi(req.get_param_value("levels")), 1, 200)); } catch (...) {}
        }
        std::lock_guard<std::mutex> lock(mutex);
        send_json(res, state.snapshot_json(req.matches[1].str(), levels));
    });

    server.Get("/orders", [&](const httplib::Request&, httplib::Response& res) {
        std::lock_guard<std::mutex> lock(mutex);
        send_json(res, state.orders_json());
    });

    server.Get("/state", [&](const httplib::Request&, httplib::Response& res) {
        std::lock_guard<std::mutex> lock(mutex);
        send_json(res, state.state_json());
    });

    server.Post("/reset", [&](const httplib::Request& req, httplib::Response& res) {
        std::lock_guard<std::mutex> lock(mutex);
        const auto clear = get_string(req.body, "clearFills", "true");
        state.reset(clear != "false" && clear != "0");
        send_json(res, "{\"ok\":true,\"service\":\"cerious.exchange\",\"reset\":true,\"state\":" + state.state_json() + "}");
    });

    server.Post("/shutdown", [&](const httplib::Request&, httplib::Response& res) {
        send_json(res, "{\"ok\":true,\"service\":\"cerious.exchange\",\"shutdown\":\"requested\"}");
        shutdown_requested.store(true);
        std::thread([&server] {
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
            server.stop();
        }).detach();
    });

    std::cerr << "cerious_exchange_server listening on 127.0.0.1:" << port << "\n";
    server.listen("127.0.0.1", port);
    shutdown_requested.store(true);
    return 0;
}
