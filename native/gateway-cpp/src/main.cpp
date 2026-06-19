#include <httplib.h>

#include <atomic>
#include <algorithm>
#include <cstdio>
#include <chrono>
#include <cctype>
#include <cstdlib>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <cmath>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace fs = std::filesystem;

namespace {

#ifdef _WIN32
FILE* open_process_pipe(const std::string& command) {
    return _popen(command.c_str(), "r");
}

int close_process_pipe(FILE* pipe) {
    return _pclose(pipe);
}
#else
FILE* open_process_pipe(const std::string& command) {
    return popen(command.c_str(), "r");
}

int close_process_pipe(FILE* pipe) {
    return pclose(pipe);
}
#endif

std::string json_escape(const std::string& value) {
    std::ostringstream out;
    for (const auto ch : value) {
        switch (ch) {
            case '"': out << "\\\""; break;
            case '\\': out << "\\\\"; break;
            case '\b': out << "\\b"; break;
            case '\f': out << "\\f"; break;
            case '\n': out << "\\n"; break;
            case '\r': out << "\\r"; break;
            case '\t': out << "\\t"; break;
            default:
                if (static_cast<unsigned char>(ch) < 0x20) {
                    out << "\\u"
                        << std::hex << std::uppercase
                        << static_cast<int>(static_cast<unsigned char>(ch));
                } else {
                    out << ch;
                }
        }
    }
    return out.str();
}

std::string q(const std::string& value) {
    return "\"" + json_escape(value) + "\"";
}

std::uint64_t now_ms() {
    return static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count());
}

std::optional<std::string> read_text(const fs::path& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return std::nullopt;
    std::ostringstream out;
    out << in.rdbuf();
    return out.str();
}

bool write_text(const fs::path& path, const std::string& content) {
    std::error_code ec;
    fs::create_directories(path.parent_path(), ec);
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    if (!out) return false;
    out << content;
    return static_cast<bool>(out);
}

std::string trim_copy(std::string value) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return "";
    const auto last = value.find_last_not_of(" \t\r\n");
    return value.substr(first, last - first + 1);
}

void set_env_if_missing(const std::string& name, const std::string& value) {
    if (name.empty() || value.empty() || std::getenv(name.c_str()) != nullptr) return;
#ifdef _WIN32
    _putenv_s(name.c_str(), value.c_str());
#else
    setenv(name.c_str(), value.c_str(), 0);
#endif
}

void load_dotenv_file(const fs::path& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return;
    std::string line;
    while (std::getline(in, line)) {
        line = trim_copy(line);
        if (line.empty() || line[0] == '#') continue;
        const auto eq = line.find('=');
        if (eq == std::string::npos) continue;
        auto name = trim_copy(line.substr(0, eq));
        auto value = trim_copy(line.substr(eq + 1));
        if (value.size() >= 2 && ((value.front() == '"' && value.back() == '"') ||
                                  (value.front() == '\'' && value.back() == '\''))) {
            value = value.substr(1, value.size() - 2);
        }
        set_env_if_missing(name, value);
    }
}

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
        const auto first = raw.find_first_not_of(" \t\r\n");
        const auto last = raw.find_last_not_of(" \t\r\n");
        if (first == std::string::npos || last == std::string::npos) return fallback;
        return raw.substr(first, last - first + 1);
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

std::optional<std::string> get_object(const std::string& json, const std::string& key) {
    const auto pattern = "\"" + key + "\"";
    auto pos = json.find(pattern);
    if (pos == std::string::npos) return std::nullopt;
    pos = json.find(':', pos + pattern.size());
    if (pos == std::string::npos) return std::nullopt;
    ++pos;
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) ++pos;
    if (pos >= json.size() || json[pos] != '{') return std::nullopt;
    std::size_t start = pos;
    int depth = 0;
    bool in_string = false;
    bool escaped = false;
    for (; pos < json.size(); ++pos) {
        const char ch = json[pos];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch == '\\') {
            escaped = true;
            continue;
        }
        if (ch == '"') {
            in_string = !in_string;
            continue;
        }
        if (in_string) continue;
        if (ch == '{') ++depth;
        if (ch == '}') {
            --depth;
            if (depth == 0) return json.substr(start, pos - start + 1);
        }
    }
    return std::nullopt;
}

std::optional<double> get_number(const std::string& json, const std::string& key) {
    const auto pattern = "\"" + key + "\"";
    auto pos = json.find(pattern);
    if (pos == std::string::npos) return std::nullopt;
    pos = json.find(':', pos + pattern.size());
    if (pos == std::string::npos) return std::nullopt;
    ++pos;
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) ++pos;
    if (pos >= json.size()) return std::nullopt;
    std::string raw;
    if (json[pos] == '"') {
        raw = get_string(json, key, "");
    } else {
        auto end = pos;
        while (end < json.size() && json[end] != ',' && json[end] != '}') ++end;
        raw = json.substr(pos, end - pos);
    }
    const auto first = raw.find_first_not_of(" \t\r\n");
    const auto last = raw.find_last_not_of(" \t\r\n");
    if (first == std::string::npos || last == std::string::npos) return std::nullopt;
    raw = raw.substr(first, last - first + 1);
    try {
        return std::stod(raw);
    } catch (...) {
        return std::nullopt;
    }
}

std::uint64_t get_u64_number(const std::string& json, const std::string& key, std::uint64_t fallback = 0) {
    const auto value = get_number(json, key);
    if (!value || !std::isfinite(*value) || *value < 0) return fallback;
    return static_cast<std::uint64_t>(*value);
}

bool is_deleted_definition(const std::string& json) {
    const auto deleted = get_string(json, "deleted", "false");
    return deleted == "true" || deleted == "1";
}

std::string env_or(const char* key, const std::string& fallback) {
    if (const char* value = std::getenv(key)) {
        if (*value) return value;
    }
    return fallback;
}

std::string shell_quote(const fs::path& path) {
    return "\"" + path.string() + "\"";
}

std::string shell_quote_arg(const std::string& value) {
    return "\"" + value + "\"";
}

std::string pipe_command(const std::string& command) {
#ifdef _WIN32
    return "\"" + command + "\"";
#else
    return command;
#endif
}

std::string upper_ascii(std::string value) {
    for (auto& ch : value) ch = static_cast<char>(std::toupper(static_cast<unsigned char>(ch)));
    return value;
}

std::string canonical_market_symbol(const std::string& raw) {
    const auto value = upper_ascii(raw);
    if (value == "ES_NQ" || value == "YM_ES" || value == "RTY_ES") return value;
    if (value.rfind("RTY", 0) == 0) return "RTY";
    if (value.rfind("ES", 0) == 0) return "ES";
    if (value.rfind("NQ", 0) == 0) return "NQ";
    if (value.rfind("YM", 0) == 0) return "YM";
    if (value.rfind("CL", 0) == 0) return "CL";
    if (value.rfind("GC", 0) == 0) return "GC";
    if (value.rfind("ZM", 0) == 0) return "ZM";
    if (value.rfind("ZS", 0) == 0) return "ZS";
    return value;
}

std::string utc_iso(std::chrono::system_clock::time_point time) {
    const auto tt = std::chrono::system_clock::to_time_t(time);
    std::tm tm{};
#ifdef _WIN32
    gmtime_s(&tm, &tt);
#else
    gmtime_r(&tt, &tm);
#endif
    std::ostringstream out;
    out << std::put_time(&tm, "%Y-%m-%dT%H:%M:%S");
    return out.str();
}

struct ProductDef {
    std::string symbol;
    double tick_size = 0.25;
    double tick_value = 0.0;
    double multiplier = 1.0;
};

ProductDef product_def_for(const std::string& raw_symbol) {
    const auto symbol = canonical_market_symbol(raw_symbol);
    if (symbol == "ES") return {"ES", 0.25, 12.50, 50.0};
    if (symbol == "NQ") return {"NQ", 0.25, 5.00, 20.0};
    if (symbol == "YM") return {"YM", 1.00, 5.00, 5.0};
    if (symbol == "RTY") return {"RTY", 0.10, 5.00, 50.0};
    if (symbol == "CL") return {"CL", 0.01, 10.00, 1000.0};
    if (symbol == "GC") return {"GC", 0.10, 10.00, 100.0};
    if (symbol == "ZM") return {"ZM", 0.10, 10.00, 100.0};
    if (symbol == "ZS") return {"ZS", 0.25, 12.50, 50.0};
    if (symbol == "ES_NQ") return {"ES_NQ", 0.25, 37.50, 150.0};
    if (symbol == "YM_ES") return {"YM_ES", 1.00, 15.00, 15.0};
    if (symbol == "RTY_ES") return {"RTY_ES", 0.10, 35.00, 350.0};
    return {symbol, 0.25, 0.0, 1.0};
}

struct SpreadDef {
    std::string symbol;
    std::string left;
    std::string right;
    double coef = 1.0;
};

std::optional<SpreadDef> spread_def_for(const std::string& raw_symbol) {
    const auto symbol = canonical_market_symbol(raw_symbol);
    if (symbol == "ES_NQ") return SpreadDef{"ES_NQ", "ES", "NQ", 0.2666667};
    if (symbol == "YM_ES") return SpreadDef{"YM_ES", "YM", "ES", 6.6666666667};
    if (symbol == "RTY_ES") return SpreadDef{"RTY_ES", "RTY", "ES", 0.4285714286};
    return std::nullopt;
}

std::vector<SpreadDef> spread_definitions() {
    return {
        SpreadDef{"ES_NQ", "ES", "NQ", 0.2666667},
        SpreadDef{"YM_ES", "YM", "ES", 6.6666666667},
        SpreadDef{"RTY_ES", "RTY", "ES", 0.4285714286},
    };
}

int env_port(const char* key, int fallback) {
    try {
        return std::stoi(env_or(key, std::to_string(fallback)));
    } catch (...) {
        return fallback;
    }
}

std::string content_type_for(const fs::path& path) {
    const auto ext = path.extension().string();
    if (ext == ".html") return "text/html; charset=utf-8";
    if (ext == ".js" || ext == ".mjs") return "application/javascript; charset=utf-8";
    if (ext == ".css") return "text/css; charset=utf-8";
    if (ext == ".json") return "application/json; charset=utf-8";
    if (ext == ".png") return "image/png";
    if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
    if (ext == ".svg") return "image/svg+xml";
    if (ext == ".ico") return "image/x-icon";
    if (ext == ".wasm") return "application/wasm";
    return "application/octet-stream";
}

struct Args {
    std::string host{"127.0.0.1"};
    int port{8000};
    std::string sim_host{"127.0.0.1"};
    int sim_port{8011};
    fs::path root;
};

Args parse_args(int argc, char** argv) {
    Args args;
    args.port = env_port("CERIOUS_BACKEND_PORT", 8000);
    args.sim_port = env_port("SIMULEX_HTTP_PORT", 8011);
    args.root = fs::current_path();
    for (int i = 1; i < argc; ++i) {
        const std::string key = argv[i];
        auto next = [&]() -> std::string {
            if (i + 1 >= argc) return "";
            return argv[++i];
        };
        if (key == "--host") args.host = next();
        else if (key == "--port") args.port = std::stoi(next());
        else if (key == "--sim-host") args.sim_host = next();
        else if (key == "--sim-port") args.sim_port = std::stoi(next());
        else if (key == "--root") args.root = fs::path(next());
    }
    return args;
}

struct MarketBook {
    std::string symbol;
    double bid = std::nan("");
    double ask = std::nan("");
    double last = std::nan("");
    int bid_size = 0;
    int ask_size = 0;
    int bid_count = 0;
    int ask_count = 0;
    int last_size = 0;
    std::uint64_t sequence = 0;
    std::uint64_t ts_ms = 0;
    bool live = false;
};

struct MarketTrade {
    std::string symbol;
    double price = std::nan("");
    int size = 0;
    std::string side{"buy"};
    std::uint64_t ts_ms = 0;
    std::uint64_t sequence = 0;
};

struct MarketBar {
    std::uint64_t timestamp = 0;
    double open = 0;
    double high = 0;
    double low = 0;
    double close = 0;
    double volume = 0;
};

struct Gateway {
    Args args;
    fs::path dist;
    fs::path data;
    std::atomic<bool> shutdown_requested{false};
    std::atomic<bool> market_data_running{false};
    mutable std::mutex market_mutex;
    std::unordered_map<std::string, MarketBook> market_books;
    std::unordered_map<std::string, std::deque<MarketTrade>> market_trades;
    std::string market_data_status{"not-started"};
    std::string market_data_error;
    std::string market_data_detail;
    std::uint64_t market_data_last_status_ms = 0;
    std::uint64_t market_data_last_heartbeat_ms = 0;
    std::uint64_t market_data_last_record_ms = 0;
    int market_data_subscription_acks = 0;
    int market_data_mappings = 0;
    int market_data_definitions = 0;
    int market_data_records = 0;
    std::thread market_data_thread;
    FILE* market_data_pipe = nullptr;

    explicit Gateway(Args next)
        : args(std::move(next)),
          dist(args.root / "apps" / "terminal" / "dist"),
          data(args.root / "data") {}

    ~Gateway() {
        stop_market_data();
    }

    std::string session_token() const {
        return "cerious-local-cpp-" + std::to_string(now_ms());
    }

    std::string portal_username() const {
        return env_or("CERIOUS_PORTAL_USERNAME", "tsturiale");
    }

    std::string portal_password() const {
        return env_or("CERIOUS_PORTAL_PASSWORD", "");
    }

    std::string admin_username() const {
        return env_or("CERIOUS_ADMIN_USERNAME", "ADMIN");
    }

    std::string admin_password() const {
        return env_or("CERIOUS_ADMIN_PASSWORD", "");
    }

    bool auth_pair_matches(const std::string& username, const std::string& password,
                           const std::string& expected_username, const std::string& expected_password) const {
        return !expected_username.empty()
            && !expected_password.empty()
            && username == expected_username
            && password == expected_password;
    }

    bool valid_login(const std::string& username, const std::string& password) const {
        return auth_pair_matches(username, password, portal_username(), portal_password())
            || auth_pair_matches(username, password, admin_username(), admin_password());
    }

    std::string auth_success_json(const std::string& username) const {
        const auto token = session_token();
        return "{\"ok\":true,\"username\":" + q(username)
            + ",\"sessionToken\":" + q(token)
            + ",\"expiresAt\":" + std::to_string(now_ms() + 86400000ULL) + "}";
    }

    fs::path price_feed_exe() const {
        auto path = args.root / "native" / "price-feed-cpp" / "build" / "cerious_price_feed.exe";
        if (fs::exists(path)) return path;
        return args.root / "native" / "price-feed-cpp" / "build" / "cerious_price_feed";
    }

    fs::path price_history_exe() const {
        auto path = args.root / "native" / "price-feed-cpp" / "build" / "cerious_price_history.exe";
        if (fs::exists(path)) return path;
        return args.root / "native" / "price-feed-cpp" / "build" / "cerious_price_history";
    }

    std::string market_data_symbols() const {
        return env_or("CERIOUS_PRICE_FEED_SYMBOLS", "ES.v.0,NQ.v.0,YM.v.0,RTY.v.0,CL.v.0,GC.v.0,ZM.v.0,ZS.v.0");
    }

    std::string market_data_stype() const {
        return env_or("CERIOUS_PRICE_FEED_STYPE", "continuous");
    }

    std::string market_data_stale_ms() const {
        return env_or("CERIOUS_PRICE_FEED_STALE_MS", "30000");
    }

    std::string market_data_reconnect_ms() const {
        return env_or("CERIOUS_PRICE_FEED_RECONNECT_MS", "5000");
    }

    std::string market_data_max_reconnect_ms() const {
        return env_or("CERIOUS_PRICE_FEED_MAX_RECONNECT_MS", "60000");
    }

    void start_market_data() {
        if (env_or("CERIOUS_MARKET_DATA_ENABLED", "1") == "0") {
            std::lock_guard<std::mutex> lock(market_mutex);
            market_data_status = "disabled";
            market_data_error.clear();
            return;
        }
        if (market_data_running.exchange(true)) return;
        const auto exe = price_feed_exe();
        if (!fs::exists(exe)) {
            std::lock_guard<std::mutex> lock(market_mutex);
            market_data_status = "unavailable";
            market_data_error = "native price feed executable not found";
            market_data_running.store(false);
            return;
        }
        if (env_or("DATABENTO_API_KEY", "").empty()) {
            std::lock_guard<std::mutex> lock(market_mutex);
            market_data_status = "unavailable";
            market_data_error = "DATABENTO_API_KEY is not configured";
            market_data_running.store(false);
            return;
        }

        market_data_thread = std::thread([this, exe]() {
            const auto log_dir = data / "logs";
            std::error_code ec;
            fs::create_directories(log_dir, ec);
            const auto err_log = log_dir / "cerious-price-feed.err.log";
            const auto command = pipe_command(shell_quote(exe)
                + " --symbols " + shell_quote_arg(market_data_symbols())
                + " --stype " + shell_quote_arg(market_data_stype())
                + " --stale-ms " + shell_quote_arg(market_data_stale_ms())
                + " --reconnect-ms " + shell_quote_arg(market_data_reconnect_ms())
                + " --max-reconnect-ms " + shell_quote_arg(market_data_max_reconnect_ms())
                + " 2>>" + shell_quote(err_log));
            {
                std::lock_guard<std::mutex> lock(market_mutex);
                market_data_status = "starting";
                market_data_error.clear();
                market_data_detail.clear();
                market_data_last_status_ms = now_ms();
            }
            FILE* pipe = open_process_pipe(command);
            market_data_pipe = pipe;
            if (!pipe) {
                std::lock_guard<std::mutex> lock(market_mutex);
                market_data_status = "unavailable";
                market_data_error = "failed to start native price feed";
                market_data_last_status_ms = now_ms();
                market_data_running.store(false);
                return;
            }

            {
                std::lock_guard<std::mutex> lock(market_mutex);
                market_data_status = "process-running";
                market_data_last_status_ms = now_ms();
            }

            char buffer[8192];
            while (market_data_running.load() && std::fgets(buffer, sizeof(buffer), pipe)) {
                ingest_market_data_line(std::string(buffer));
            }
            close_process_pipe(pipe);
            market_data_pipe = nullptr;
            market_data_running.store(false);
            std::lock_guard<std::mutex> lock(market_mutex);
            if (market_data_status != "error") market_data_status = "stopped";
            market_data_last_status_ms = now_ms();
        });
        market_data_thread.detach();
    }

    void stop_market_data() {
        market_data_running.store(false);
    }

    static bool finite(double value) {
        return std::isfinite(value);
    }

    static double mid_or_last(const MarketBook& book) {
        if (finite(book.last)) return book.last;
        if (finite(book.bid) && finite(book.ask)) return (book.bid + book.ask) / 2.0;
        if (finite(book.bid)) return book.bid;
        if (finite(book.ask)) return book.ask;
        return std::nan("");
    }

    bool ingest_market_status_line(const std::string& line) {
        if (line.find("\"type\":\"market.status\"") == std::string::npos) return false;
        const auto status = get_string(line, "status", "system");
        const auto detail = get_string(line, "detail", "");
        const auto ts_ms = get_u64_number(line, "tsMs", now_ms());
        std::lock_guard<std::mutex> lock(market_mutex);
        market_data_status = status;
        market_data_detail = detail;
        market_data_last_status_ms = ts_ms ? ts_ms : now_ms();
        if (status == "heartbeat") {
            market_data_last_heartbeat_ms = market_data_last_status_ms;
        } else if (status == "subscription_ack") {
            ++market_data_subscription_acks;
        } else if (status == "symbol_mapping") {
            market_data_mappings = std::max(market_data_mappings, static_cast<int>(get_number(line, "mappings").value_or(market_data_mappings + 1)));
        } else if (status == "definition") {
            market_data_definitions = std::max(market_data_definitions, static_cast<int>(get_number(line, "definitions").value_or(market_data_definitions + 1)));
        } else if (status == "record") {
            market_data_records = std::max(market_data_records, static_cast<int>(get_number(line, "records").value_or(market_data_records + 1)));
            market_data_last_record_ms = market_data_last_status_ms;
        } else if (status == "error") {
            market_data_error = detail;
        } else if (status == "reconnecting") {
            market_data_error = detail;
        }
        if (status != "error" && status != "reconnecting" && status != "slow_reader_warning") {
            market_data_error.clear();
        }
        return true;
    }

    void ingest_market_data_line(const std::string& line) {
        if (ingest_market_status_line(line)) return;
        if (line.find("\"type\":\"market.mbp1\"") == std::string::npos) return;
        const auto raw_symbol = get_string(line, "symbol", "");
        const auto symbol = canonical_market_symbol(raw_symbol);
        if (symbol.empty()) return;
        auto bid = get_number(line, "bid").value_or(std::nan(""));
        auto ask = get_number(line, "ask").value_or(std::nan(""));
        const auto price = get_number(line, "price").value_or(std::nan(""));
        const auto action = get_string(line, "action", "");
        const auto side_code = get_string(line, "side", "");
        const auto size = static_cast<int>(get_number(line, "size").value_or(0));
        const auto bid_size = static_cast<int>(get_number(line, "bidSize").value_or(0));
        const auto ask_size = static_cast<int>(get_number(line, "askSize").value_or(0));
        const auto bid_count = static_cast<int>(get_number(line, "bidCount").value_or(0));
        const auto ask_count = static_cast<int>(get_number(line, "askCount").value_or(0));
        const auto sequence = get_u64_number(line, "sequence", now_ms());
        const auto ts_ns = get_u64_number(line, "tsEventNs", now_ms() * 1000000ULL);
        const auto ts_ms = ts_ns / 1000000ULL;

        std::vector<MarketBook> sim_updates;
        {
            std::lock_guard<std::mutex> lock(market_mutex);
            ++market_data_records;
            market_data_last_record_ms = now_ms();
            if (market_data_status != "error" && market_data_status != "reconnecting") {
                market_data_status = "streaming";
                market_data_detail = "MBP-1 records received";
                market_data_error.clear();
            }
            auto& book = market_books[symbol];
            if (book.symbol.empty()) book.symbol = symbol;
            if (finite(bid)) book.bid = bid;
            if (finite(ask)) book.ask = ask;
            if (bid_size >= 0) book.bid_size = bid_size;
            if (ask_size >= 0) book.ask_size = ask_size;
            if (bid_count >= 0) book.bid_count = bid_count;
            if (ask_count >= 0) book.ask_count = ask_count;
            book.sequence = sequence;
            book.ts_ms = ts_ms ? ts_ms : now_ms();
            book.live = true;
            if (action == "T" && finite(price)) {
                book.last = price;
                book.last_size = std::max(0, size);
                MarketTrade trade;
                trade.symbol = symbol;
                trade.price = price;
                trade.size = std::max(0, size);
                trade.side = side_code == "A" ? "buy" : "sell";
                trade.ts_ms = book.ts_ms;
                trade.sequence = sequence;
                auto& tape = market_trades[symbol];
                tape.push_back(trade);
                while (tape.size() > 200) tape.pop_front();
            }
            if (finite(book.bid) && finite(book.ask)) {
                sim_updates.push_back(book);
            }
            for (const auto& spread : spread_definitions()) {
                if (spread.left != symbol && spread.right != symbol) continue;
                const auto spread_book = book_unlocked(spread.symbol);
                if (spread_book && finite(spread_book->bid) && finite(spread_book->ask)) {
                    sim_updates.push_back(*spread_book);
                }
            }
        }

        for (const auto& update : sim_updates) {
            publish_market_to_simulex(update);
        }
    }

    void publish_market_to_simulex(const MarketBook& book) const {
        std::ostringstream body;
        body << std::fixed << std::setprecision(9)
             << "{\"symbol\":" << q(book.symbol)
             << ",\"bid\":" << book.bid
             << ",\"ask\":" << book.ask
             << ",\"bidSize\":" << book.bid_size
             << ",\"askSize\":" << book.ask_size;
        if (finite(book.last)) {
            body << ",\"last\":" << book.last
                 << ",\"lastSize\":" << book.last_size;
        }
        body << ",\"sequence\":" << book.sequence
             << ",\"timestampNs\":" << (book.ts_ms * 1000000ULL)
             << "}";
        sim_post("/market", body.str());
    }

    std::optional<MarketBook> book_unlocked(const std::string& raw_symbol) const {
        const auto symbol = canonical_market_symbol(raw_symbol);
        if (const auto spread = spread_def_for(symbol)) {
            const auto left_it = market_books.find(spread->left);
            const auto right_it = market_books.find(spread->right);
            if (left_it == market_books.end() || right_it == market_books.end()) return std::nullopt;
            const auto& left = left_it->second;
            const auto& right = right_it->second;
            if (!finite(left.bid) || !finite(left.ask) || !finite(right.bid) || !finite(right.ask)) return std::nullopt;
            MarketBook out;
            out.symbol = spread->symbol;
            out.bid = left.bid - spread->coef * right.ask;
            out.ask = left.ask - spread->coef * right.bid;
            const auto left_last = mid_or_last(left);
            const auto right_last = mid_or_last(right);
            if (finite(left_last) && finite(right_last)) out.last = left_last - spread->coef * right_last;
            out.bid_size = std::min(left.bid_size, right.ask_size);
            out.ask_size = std::min(left.ask_size, right.bid_size);
            out.bid_count = std::min(left.bid_count, right.ask_count);
            out.ask_count = std::min(left.ask_count, right.bid_count);
            out.last_size = std::min(left.last_size, right.last_size);
            out.sequence = std::max(left.sequence, right.sequence);
            out.ts_ms = std::max(left.ts_ms, right.ts_ms);
            out.live = left.live && right.live;
            return out;
        }
        const auto it = market_books.find(symbol);
        if (it == market_books.end()) return std::nullopt;
        return it->second;
    }

    std::optional<MarketBook> current_book(const std::string& raw_symbol) const {
        std::lock_guard<std::mutex> lock(market_mutex);
        return book_unlocked(raw_symbol);
    }

    std::string market_book_json(const MarketBook& book) const {
        const auto def = product_def_for(book.symbol);
        const auto mid = (book.bid + book.ask) / 2.0;
        const auto spread = book.ask - book.bid;
        std::ostringstream out;
        out << std::fixed << std::setprecision(9)
            << "{\"ok\":true,\"symbol\":" << q(book.symbol)
            << ",\"venue\":\"CME\",\"source\":\"databento-live-cpp\""
            << ",\"bids\":[{\"price\":" << book.bid << ",\"size\":" << book.bid_size << ",\"count\":" << book.bid_count << "}]"
            << ",\"asks\":[{\"price\":" << book.ask << ",\"size\":" << book.ask_size << ",\"count\":" << book.ask_count << "}]"
            << ",\"bestBid\":" << book.bid
            << ",\"bestAsk\":" << book.ask
            << ",\"bidSize\":" << book.bid_size
            << ",\"askSize\":" << book.ask_size
            << ",\"bidCount\":" << book.bid_count
            << ",\"askCount\":" << book.ask_count
            << ",\"mid\":" << mid
            << ",\"spread\":" << spread;
        if (finite(book.last)) out << ",\"ltp\":" << book.last << ",\"ltpSize\":" << book.last_size;
        out << ",\"tsMs\":" << book.ts_ms
            << ",\"sequence\":" << book.sequence
            << ",\"tickSize\":" << def.tick_size
            << ",\"tickValue\":" << def.tick_value
            << ",\"multiplier\":" << def.multiplier
            << "}";
        return out.str();
    }

    std::string market_trades_json(const std::string& raw_symbol) const {
        const auto symbol = canonical_market_symbol(raw_symbol);
        const auto def = product_def_for(symbol);
        std::deque<MarketTrade> tape;
        {
            std::lock_guard<std::mutex> lock(market_mutex);
            if (const auto spread = spread_def_for(symbol)) {
                if (const auto book = book_unlocked(symbol); book && finite(book->last)) {
                    MarketTrade synthetic;
                    synthetic.symbol = symbol;
                    synthetic.price = book->last;
                    synthetic.size = std::max(0, book->last_size);
                    synthetic.side = "buy";
                    synthetic.ts_ms = book->ts_ms;
                    synthetic.sequence = book->sequence;
                    tape.push_back(synthetic);
                }
            } else {
                const auto it = market_trades.find(symbol);
                if (it != market_trades.end()) tape = it->second;
            }
        }
        std::ostringstream out;
        out << std::fixed << std::setprecision(9)
            << "{\"ok\":true,\"symbol\":" << q(symbol) << ",\"trades\":[";
        for (std::size_t i = 0; i < tape.size(); ++i) {
            const auto& trade = tape[i];
            if (i) out << ",";
            out << "{\"symbol\":" << q(symbol)
                << ",\"venue\":\"CME\",\"source\":\"databento-live-cpp\""
                << ",\"timestamp\":" << trade.ts_ms
                << ",\"price\":" << trade.price
                << ",\"size\":" << trade.size
                << ",\"side\":" << q(trade.side)
                << ",\"bestBid\":null,\"bestAsk\":null"
                << ",\"tickSize\":" << def.tick_size
                << ",\"tickValue\":" << def.tick_value
                << ",\"multiplier\":" << def.multiplier
                << "}";
        }
        out << "]}";
        return out.str();
    }

    std::string market_catalog_json() const {
        const std::vector<std::string> symbols{
            "ES", "NQ", "YM", "RTY", "CL", "GC", "ZM", "ZS", "ES_NQ", "YM_ES", "RTY_ES",
        };
        std::ostringstream out;
        out << std::fixed << std::setprecision(9)
            << "{\"ok\":true,\"runtime\":\"cpp\",\"source\":\"gateway.product_definitions\",\"markets\":[";
        for (std::size_t i = 0; i < symbols.size(); ++i) {
            const auto& symbol = symbols[i];
            const auto def = product_def_for(symbol);
            const auto book = current_book(symbol);
            const auto spot = book ? mid_or_last(*book) : std::numeric_limits<double>::quiet_NaN();
            if (i) out << ",";
            out << "{\"key\":" << q(symbol)
                << ",\"asset\":" << q(symbol)
                << ",\"title\":" << q(symbol)
                << ",\"provider\":\"cme\""
                << ",\"timeframe\":\"live\""
                << ",\"question\":" << q("CME " + symbol)
                << ",\"up_pct\":0"
                << ",\"down_pct\":0"
                << ",\"volume\":0"
                << ",\"expiry_ts\":0"
                << ",\"live\":true"
                << ",\"last_update_ms\":" << (book ? book->ts_ms : 0)
                << ",\"tickSize\":" << def.tick_size
                << ",\"tickValue\":" << def.tick_value
                << ",\"multiplier\":" << def.multiplier;
            if (finite(spot)) {
                out << ",\"price_to_beat\":" << spot
                    << ",\"start_price\":" << spot
                    << ",\"resolution_price\":" << spot;
            }
            out << "}";
        }
        out << "]}";
        return out.str();
    }

    std::string market_data_status_json() const {
        const auto current_ms = now_ms();
        std::string status;
        std::string error;
        std::string detail;
        std::uint64_t last_status_ms = 0;
        std::uint64_t last_heartbeat_ms = 0;
        std::uint64_t last_record_ms = 0;
        int subscription_acks = 0;
        int mappings = 0;
        int definitions = 0;
        int records = 0;
        std::vector<std::string> symbols;
        {
            std::lock_guard<std::mutex> lock(market_mutex);
            status = market_data_status;
            error = market_data_error;
            detail = market_data_detail;
            last_status_ms = market_data_last_status_ms;
            last_heartbeat_ms = market_data_last_heartbeat_ms;
            last_record_ms = market_data_last_record_ms;
            subscription_acks = market_data_subscription_acks;
            mappings = market_data_mappings;
            definitions = market_data_definitions;
            records = market_data_records;
            symbols.reserve(market_books.size());
            for (const auto& [symbol, book] : market_books) {
                if (finite(book.bid) && finite(book.ask)) symbols.push_back(symbol);
            }
        }

        const bool running = market_data_running.load();
        const bool subscribed = subscription_acks > 0;
        const auto recent_signal_ms = std::max({last_status_ms, last_heartbeat_ms, last_record_ms});
        const bool recent_signal = recent_signal_ms > 0 && current_ms >= recent_signal_ms
            && (current_ms - recent_signal_ms) < 180000ULL;
        const bool connected = running
            && status != "error"
            && status != "unavailable"
            && status != "disabled"
            && (subscribed || mappings > 0 || definitions > 0 || records > 0 || recent_signal);
        const bool heartbeat_ok = connected
            && (last_heartbeat_ms > 0 || last_record_ms > 0 || subscribed)
            && recent_signal;
        const bool price_ready = !symbols.empty();

        std::ostringstream out;
        out << "{\"ok\":true"
            << ",\"provider\":\"databento\""
            << ",\"dataset\":\"GLBX.MDP3\""
            << ",\"schema\":\"mbp-1\""
            << ",\"status\":" << q(status)
            << ",\"detail\":" << q(detail)
            << ",\"running\":" << (running ? "true" : "false")
            << ",\"connected\":" << (connected ? "true" : "false")
            << ",\"subscribed\":" << (subscribed ? "true" : "false")
            << ",\"heartbeatOk\":" << (heartbeat_ok ? "true" : "false")
            << ",\"priceReady\":" << (price_ready ? "true" : "false")
            << ",\"subscriptionAcks\":" << subscription_acks
            << ",\"mappings\":" << mappings
            << ",\"definitions\":" << definitions
            << ",\"records\":" << records
            << ",\"lastStatusMs\":" << last_status_ms
            << ",\"lastHeartbeatMs\":" << last_heartbeat_ms
            << ",\"lastRecordMs\":" << last_record_ms
            << ",\"error\":" << q(error)
            << ",\"bookSymbols\":[";
        for (std::size_t i = 0; i < symbols.size(); ++i) {
            if (i) out << ",";
            out << q(symbols[i]);
        }
        out << "]}";
        return out.str();
    }

    std::string execution_status_json() const {
        const auto sim = sim_get("/health");
        const bool sim_required = upper_ascii(env_or("CERIOUS_EXECUTION_DESTINATION", "simulex")) == "SIMULEX";
        const bool sim_ok = sim && sim->status >= 200 && sim->status < 300;
        return "{\"ok\":true"
            ",\"destination\":\"simulex\""
            ",\"exchange\":\"simulex\""
            ",\"required\":" + std::string(sim_required ? "true" : "false")
            + ",\"healthy\":" + std::string((!sim_required || sim_ok) ? "true" : "false")
            + ",\"stateOwner\":\"simulex.exchange\"}";
    }

    std::vector<std::string> command_lines(const std::string& command, std::size_t max_lines = 2000) const {
        std::vector<std::string> lines;
        FILE* pipe = open_process_pipe(command);
        if (!pipe) return lines;
        char buffer[8192];
        while (lines.size() < max_lines && std::fgets(buffer, sizeof(buffer), pipe)) {
            lines.emplace_back(buffer);
        }
        close_process_pipe(pipe);
        return lines;
    }

    std::string history_schema_for_interval(const std::string& interval) const {
        const auto value = upper_ascii(interval);
        if (value == "1H" || value == "60" || value == "60M") return "ohlcv-1h";
        if (value == "1D" || value == "D" || value == "1440") return "ohlcv-1d";
        return "ohlcv-1m";
    }

    int interval_minutes(const std::string& interval) const {
        const auto value = upper_ascii(interval);
        if (value == "1D" || value == "D" || value == "1440") return 1440;
        if (value == "1H" || value == "60" || value == "60M") return 60;
        if (value == "30M" || value == "30") return 30;
        if (value == "5M" || value == "5") return 5;
        return 1;
    }

    std::vector<MarketBar> aggregate_bars(std::vector<MarketBar> bars, const int minutes, const int limit) const {
        if (minutes <= 1 || bars.empty()) return bars;
        const std::uint64_t bucket_ms = static_cast<std::uint64_t>(minutes) * 60ULL * 1000ULL;
        std::sort(bars.begin(), bars.end(), [](const MarketBar& left, const MarketBar& right) {
            return left.timestamp < right.timestamp;
        });

        std::vector<MarketBar> out;
        std::uint64_t current_bucket = 0;
        for (const auto& bar : bars) {
            const auto bucket = (bar.timestamp / bucket_ms) * bucket_ms;
            if (out.empty() || bucket != current_bucket) {
                MarketBar next = bar;
                next.timestamp = bucket;
                out.push_back(next);
                current_bucket = bucket;
                continue;
            }
            auto& active = out.back();
            active.high = std::max(active.high, bar.high);
            active.low = std::min(active.low, bar.low);
            active.close = bar.close;
            active.volume += bar.volume;
        }
        if (out.size() > static_cast<std::size_t>(limit)) {
            out.erase(out.begin(), out.end() - limit);
        }
        return out;
    }

    std::vector<MarketBar> history_bars_for_symbol(const std::string& raw_symbol, const std::string& interval, int limit) const {
        const auto symbol = canonical_market_symbol(raw_symbol);
        const auto exe = price_history_exe();
        if (!fs::exists(exe)) {
            std::cerr << "history unavailable: native price history executable not found at "
                      << exe.string() << std::endl;
            return {};
        }
        if (env_or("DATABENTO_API_KEY", "").empty()) {
            std::cerr << "history unavailable: DATABENTO_API_KEY is not configured in gateway process" << std::endl;
            return {};
        }
        const auto schema = history_schema_for_interval(interval);
        const auto minutes = std::max(1, interval_minutes(interval));
        const auto records_per_bar = schema == "ohlcv-1m" ? minutes : 1;
        const auto fetch_limit = std::max(limit * records_per_bar + records_per_bar * 4, limit + 20);
        const auto now = std::chrono::system_clock::now();
        const auto end_time = now - std::chrono::minutes(15);
        const auto lookback_minutes = std::max(minutes * (limit + 4), 60);
        const auto start = utc_iso(end_time - std::chrono::minutes(lookback_minutes));
        const auto end = utc_iso(end_time);
        const auto data_symbol = symbol + ".v.0";
        const auto log_dir = data / "logs";
        std::error_code ec;
        fs::create_directories(log_dir, ec);
        const auto safe_symbol = upper_ascii(symbol);
        const auto err_log = log_dir / ("cerious-price-history-" + safe_symbol + "-" + std::to_string(now_ms()) + ".err.log");
        const auto command = pipe_command(shell_quote(exe)
            + " --symbols " + shell_quote_arg(data_symbol)
            + " --stype " + shell_quote_arg(market_data_stype())
            + " --schema " + shell_quote_arg(schema)
            + " --start " + shell_quote_arg(start)
            + " --end " + shell_quote_arg(end)
            + " --limit " + std::to_string(std::max(1, fetch_limit))
            + " 2>>" + shell_quote(err_log));

        std::vector<MarketBar> bars;
        for (const auto& line : command_lines(command, static_cast<std::size_t>(std::max(1, fetch_limit + 100)))) {
            if (line.find("\"type\":\"market.ohlcv\"") == std::string::npos) continue;
            MarketBar bar;
            const auto ts_ns = get_u64_number(line, "tsEventNs", 0);
            bar.timestamp = ts_ns / 1000000ULL;
            bar.open = get_number(line, "open").value_or(std::nan(""));
            bar.high = get_number(line, "high").value_or(std::nan(""));
            bar.low = get_number(line, "low").value_or(std::nan(""));
            bar.close = get_number(line, "close").value_or(std::nan(""));
            bar.volume = get_number(line, "volume").value_or(0);
            if (bar.timestamp && finite(bar.open) && finite(bar.high) && finite(bar.low) && finite(bar.close)) {
                bars.push_back(bar);
            }
        }
        bars = aggregate_bars(std::move(bars), minutes, limit);
        if (bars.size() > static_cast<std::size_t>(limit)) {
            bars.erase(bars.begin(), bars.end() - limit);
        }
        return bars;
    }

    std::vector<MarketBar> history_bars(const std::string& raw_symbol, const std::string& interval, int limit) const {
        const auto symbol = canonical_market_symbol(raw_symbol);
        if (const auto spread = spread_def_for(symbol)) {
            auto left = history_bars_for_symbol(spread->left, interval, limit);
            auto right = history_bars_for_symbol(spread->right, interval, limit);
            std::unordered_map<std::uint64_t, MarketBar> right_by_ts;
            for (const auto& bar : right) right_by_ts[bar.timestamp] = bar;
            std::vector<MarketBar> out;
            for (const auto& left_bar : left) {
                const auto it = right_by_ts.find(left_bar.timestamp);
                if (it == right_by_ts.end()) continue;
                const auto& right_bar = it->second;
                MarketBar bar;
                bar.timestamp = left_bar.timestamp;
                bar.open = left_bar.open - spread->coef * right_bar.open;
                bar.high = left_bar.high - spread->coef * right_bar.low;
                bar.low = left_bar.low - spread->coef * right_bar.high;
                bar.close = left_bar.close - spread->coef * right_bar.close;
                bar.volume = std::min(left_bar.volume, right_bar.volume);
                out.push_back(bar);
            }
            if (out.size() > static_cast<std::size_t>(limit)) {
                out.erase(out.begin(), out.end() - limit);
            }
            return out;
        }
        return history_bars_for_symbol(symbol, interval, limit);
    }

    std::string bars_json(const std::string& raw_symbol, const std::string& interval, int limit) const {
        const auto symbol = canonical_market_symbol(raw_symbol);
        const auto bars = history_bars(symbol, interval, limit);
        std::ostringstream out;
        out << std::fixed << std::setprecision(9)
            << "{\"ok\":true,\"runtime\":\"cpp\",\"source\":\"databento-historical-cpp\",\"symbol\":" << q(symbol)
            << ",\"bars\":[";
        for (std::size_t i = 0; i < bars.size(); ++i) {
            const auto& bar = bars[i];
            if (i) out << ",";
            out << "{\"timestamp\":" << bar.timestamp
                << ",\"open\":" << bar.open
                << ",\"high\":" << bar.high
                << ",\"low\":" << bar.low
                << ",\"close\":" << bar.close
                << ",\"volume\":" << bar.volume
                << "}";
        }
        out << "]}";
        return out.str();
    }

    httplib::Result sim_get(const std::string& path) const {
        httplib::Client client(args.sim_host, args.sim_port);
        client.set_connection_timeout(2, 0);
        client.set_read_timeout(4, 0);
        return client.Get(path);
    }

    httplib::Result sim_post(const std::string& path, const std::string& body) const {
        httplib::Client client(args.sim_host, args.sim_port);
        client.set_connection_timeout(2, 0);
        client.set_read_timeout(5, 0);
        return client.Post(path, body, "application/json");
    }

    std::string sim_state_json() const {
        auto state = sim_get("/state");
        if (state && state->status >= 200 && state->status < 300) return state->body;
        return "{\"service\":\"simulex.exchange\",\"simOrders\":[],\"simPositions\":[],\"fills\":{},\"simMessages\":[\"SIMULEX STATE UNAVAILABLE\"]}";
    }

    std::string wrap_state_payload(const std::string& state) const {
        return "{\"ok\":true,\"service\":\"simulex.exchange\",\"state\":" + state
            + ",\"simOrders\":[],\"simPositions\":[],\"fills\":{},\"simMessages\":[]}";
    }

    std::string algo_definitions_json() const {
        const auto dir = data / "algo-definitions";
        std::vector<std::string> defs;
        std::error_code ec;
        if (!fs::exists(dir, ec)) return "[]";
        for (const auto& entry : fs::directory_iterator(dir, ec)) {
            if (ec) break;
            if (!entry.is_regular_file()) continue;
            const auto path = entry.path();
            if (path.extension() != ".json") continue;
            if (path.filename().string().starts_with("_")) continue;
            auto content = read_text(path);
            if (content && !is_deleted_definition(*content)) {
                defs.push_back(*content);
            }
        }
        std::ostringstream out;
        out << "[";
        for (std::size_t i = 0; i < defs.size(); ++i) {
            if (i) out << ",";
            out << defs[i];
        }
        out << "]";
        return out.str();
    }

    void send_json(httplib::Response& res, const std::string& body, int status = 200) const {
        res.status = status;
        res.set_header("Cache-Control", "no-store");
        res.set_content(body, "application/json");
    }

    void register_routes(httplib::Server& server) {
        server.Get("/api/health", [&](const httplib::Request&, httplib::Response& res) {
            const auto sim = sim_get("/health");
            const bool sim_ok = sim && sim->status >= 200 && sim->status < 300;
            send_json(res,
                "{\"ok\":true,\"app\":\"cerious-systems\",\"runtime\":\"cpp\","
                "\"gateway\":\"cerious_gateway\",\"backend\":\"native-cpp\","
                "\"simulex\":" + std::string(sim_ok ? "true" : "false")
                + ",\"marketData\":" + market_data_status_json()
                + ",\"execution\":" + execution_status_json() + "}");
        });

        server.Get("/health", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, "{\"ok\":true,\"app\":\"cerious-systems\",\"runtime\":\"cpp\"}");
        });

        server.Post("/api/auth/login", [&](const httplib::Request& req, httplib::Response& res) {
            const auto username = get_string(req.body, "username", "");
            const auto password = get_string(req.body, "password", "");
            if (!valid_login(username, password)) {
                send_json(res, "{\"ok\":false,\"detail\":\"Invalid username or password\"}", 401);
                return;
            }
            send_json(res, auth_success_json(username));
        });

        server.Post("/api/auth/auto", [&](const httplib::Request&, httplib::Response& res) {
            const auto username = portal_username();
            if (portal_password().empty()) {
                send_json(res, "{\"ok\":false,\"detail\":\"Portal credentials not configured\"}", 503);
                return;
            }
            send_json(res, auth_success_json(username));
        });

        server.Get("/api/auth/session", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, "{\"ok\":true,\"username\":" + q(portal_username()) + ",\"runtime\":\"cpp\"}");
        });

        server.Post("/api/auth/logout", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, "{\"ok\":true}");
        });

        server.Get("/api/system/ready", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, "{\"ok\":true,\"runtime\":\"cpp\",\"services\":[\"gateway\",\"simulex\"]}");
        });

        server.Get("/api/market-data/status", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, market_data_status_json());
        });

        server.Get("/api/execution/status", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, execution_status_json());
        });

        server.Get("/api/system/contract", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res,
                "{\"ok\":true,\"runtime\":\"cpp\",\"orderPath\":\"/api/order\","
                "\"executionDestination\":\"simulex\",\"stateOwner\":\"simulex.exchange\"}");
        });

        server.Post("/api/system/warmup", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, "{\"ok\":true,\"status\":\"ready\",\"runtime\":\"cpp\",\"warmupMs\":0}");
        });

        server.Post("/api/system/shutdown", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, "{\"ok\":true,\"runtime\":\"cpp\",\"shutdown\":\"requested\"}");
            sim_post("/shutdown", "{}");
            shutdown_requested.store(true);
        });

        server.Get("/api/workspaces/saved", [&](const httplib::Request&, httplib::Response& res) {
            const auto latest = read_text(data / "workspace-store" / "tsturiale" / "latest.json");
            if (latest) send_json(res, "{\"ok\":true,\"workspaces\":[" + *latest + "]}");
            else send_json(res, "{\"ok\":true,\"workspaces\":[]}");
        });

        server.Get("/api/workspaces/recovered", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, "{\"ok\":true,\"workspaces\":[]}");
        });

        server.Post("/api/workspaces/save", [&](const httplib::Request& req, httplib::Response& res) {
            const auto path = data / "workspace-store" / "tsturiale" / "native-last-save.json";
            const bool ok = write_text(path, req.body);
            send_json(res, ok ? "{\"ok\":true,\"runtime\":\"cpp\"}" : "{\"ok\":false,\"detail\":\"workspace save failed\"}", ok ? 200 : 500);
        });

        server.Get("/api/algo-manager/state", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, "{\"ok\":true,\"runtime\":\"cpp\",\"definitions\":" + algo_definitions_json()
                + ",\"state\":{\"held\":0,\"quoting\":0,\"paused\":0,\"draft\":0}}");
        });

        server.Post("/api/algo-definitions/save", [&](const httplib::Request& req, httplib::Response& res) {
            const auto definition = get_object(req.body, "definition").value_or(req.body);
            const auto id = get_string(definition, "id", "algo-" + std::to_string(now_ms()));
            const auto path = data / "algo-definitions" / (id + ".json");
            const bool ok = write_text(path, definition);
            send_json(res, ok ? "{\"ok\":true,\"runtime\":\"cpp\"}" : "{\"ok\":false,\"detail\":\"algo definition save failed\"}", ok ? 200 : 500);
        });

        server.Post("/api/order", [&](const httplib::Request& req, httplib::Response& res) {
            auto result = sim_post("/send", req.body);
            if (!result) {
                send_json(res, "{\"ok\":false,\"detail\":\"simulex unavailable\",\"state\":" + sim_state_json() + "}", 503);
                return;
            }
            res.status = result->status;
            res.set_header("Cache-Control", "no-store");
            res.set_content(result->body, "application/json");
        });

        server.Post(R"(/api/acme/orders/([^/]+)/cancel)", [&](const httplib::Request& req, httplib::Response& res) {
            const std::string order_id = req.matches[1];
            auto result = sim_post("/cancel", "{\"orderId\":" + q(order_id) + "}");
            if (!result) {
                send_json(res, "{\"ok\":false,\"detail\":\"simulex unavailable\",\"state\":" + sim_state_json() + "}", 503);
                return;
            }
            res.status = result->status;
            res.set_header("Cache-Control", "no-store");
            res.set_content(result->body, "application/json");
        });

        server.Post("/api/acme/orders/cancel-all", [&](const httplib::Request&, httplib::Response& res) {
            auto result = sim_post("/reset", "{\"clearFills\":false,\"reason\":\"cancel all working orders\"}");
            if (!result) {
                send_json(res, "{\"ok\":false,\"detail\":\"simulex unavailable\",\"state\":" + sim_state_json() + "}", 503);
                return;
            }
            res.status = result->status;
            res.set_header("Cache-Control", "no-store");
            res.set_content(result->body, "application/json");
        });

        server.Post("/api/acme/session/reset", [&](const httplib::Request& req, httplib::Response& res) {
            auto result = sim_post("/reset", req.body.empty() ? "{\"clearFills\":true}" : req.body);
            if (!result) {
                send_json(res, "{\"ok\":false,\"detail\":\"simulex unavailable\",\"state\":" + sim_state_json() + "}", 503);
                return;
            }
            res.status = result->status;
            res.set_header("Cache-Control", "no-store");
            res.set_content(result->body, "application/json");
        });

        server.Get("/api/acme/positions-orders", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, sim_state_json());
        });

        server.Get(R"(/api/cme/book/([^/]+))", [&](const httplib::Request& req, httplib::Response& res) {
            const auto symbol = canonical_market_symbol(req.matches[1].str());
            const auto book = current_book(symbol);
            if (!book || !finite(book->bid) || !finite(book->ask)) {
                send_json(res, "{\"ok\":false,\"symbol\":" + q(symbol)
                    + ",\"detail\":\"market data not yet available from native price service\"}", 503);
                return;
            }
            send_json(res, market_book_json(*book));
        });

        server.Get(R"(/api/cme/trades/([^/]+))", [&](const httplib::Request& req, httplib::Response& res) {
            send_json(res, market_trades_json(req.matches[1].str()));
        });

        server.Get("/api/markets", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, market_catalog_json());
        });

        server.Get(R"(/api/bars/([^/]+))", [&](const httplib::Request& req, httplib::Response& res) {
            const auto symbol = canonical_market_symbol(req.matches[1].str());
            const auto interval = req.has_param("interval") ? req.get_param_value("interval") : "1m";
            int limit = 300;
            if (req.has_param("limit")) {
                try {
                    limit = std::clamp(std::stoi(req.get_param_value("limit")), 1, 300);
                } catch (...) {
                    limit = 300;
                }
            }
            send_json(res, bars_json(symbol, interval, limit));
        });

        server.Get("/api/metrics", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, "{\"ok\":true,\"runtime\":\"cpp\",\"metrics\":{}}");
        });

        server.Get("/api/alerts/sms/status", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, "{\"ok\":true,\"enabled\":true,\"runtime\":\"cpp\"}");
        });

        server.Post("/api/alerts/sms", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, "{\"ok\":true,\"queued\":true,\"runtime\":\"cpp\"}");
        });

        server.Get("/api/downloads/desktop/status", [&](const httplib::Request&, httplib::Response& res) {
            const bool exists = fs::exists(data / "downloads" / "Cerious Systems_0.1.0_x64-setup.exe");
            send_json(res, std::string("{\"ok\":true,\"win64Ready\":") + (exists ? "true" : "false") + ",\"runtime\":\"cpp\"}");
        });

        server.Get("/api/downloads/desktop/win64", [&](const httplib::Request&, httplib::Response& res) {
            const auto installer = data / "downloads" / "Cerious Systems_0.1.0_x64-setup.exe";
            auto content = read_text(installer);
            if (!content) {
                res.status = 404;
                res.set_content("Desktop installer not found", "text/plain");
                return;
            }
            res.set_header("Content-Disposition", "attachment; filename=\"CeriousSystems-Desktop-Setup.exe\"");
            res.set_content(*content, "application/vnd.microsoft.portable-executable");
        });

        server.Get(R"(/api/.*)", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, "{\"ok\":true,\"runtime\":\"cpp\",\"data\":null}");
        });

        server.Get(R"(/(.*))", [&](const httplib::Request& req, httplib::Response& res) {
            auto relative = req.path == "/" ? std::string("index.html") : req.path.substr(1);
            if (relative.find("..") != std::string::npos) {
                res.status = 400;
                res.set_content("bad path", "text/plain");
                return;
            }
            auto target = dist / fs::path(relative);
            if (!fs::exists(target) || fs::is_directory(target)) {
                target = dist / "index.html";
            }
            auto content = read_text(target);
            if (!content) {
                res.status = 404;
                res.set_content("Cerious terminal bundle not found. Build apps/terminal first.", "text/plain");
                return;
            }
            res.set_content(*content, content_type_for(target));
        });
    }
};

} // namespace

int main(int argc, char** argv) {
    auto args = parse_args(argc, argv);
    load_dotenv_file(args.root / ".env");
    Gateway gateway(args);

    httplib::Server server;
    server.new_task_queue = [] {
        return new httplib::ThreadPool(32, 512);
    };
    server.set_read_timeout(10, 0);
    server.set_write_timeout(10, 0);
    server.set_idle_interval(1, 0);

    gateway.start_market_data();
    gateway.register_routes(server);

    std::cerr << "cerious_gateway: native C++ gateway listening on "
              << args.host << ":" << args.port << " root=" << args.root << std::endl;

    std::thread shutdown_thread([&]() {
        while (!gateway.shutdown_requested.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        server.stop();
    });

    const bool ok = server.listen(args.host, args.port);
    gateway.shutdown_requested.store(true);
    shutdown_thread.join();
    if (!ok) {
        std::cerr << "cerious_gateway: failed to listen on " << args.host << ":" << args.port << std::endl;
        return 1;
    }
    return 0;
}
