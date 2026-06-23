#include <httplib.h>

#include <atomic>
#include <algorithm>
#include <cstdio>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <cmath>
#include <mutex>
#include <numeric>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
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
    auto text = out.str();
    if (text.size() >= 3
        && static_cast<unsigned char>(text[0]) == 0xEF
        && static_cast<unsigned char>(text[1]) == 0xBB
        && static_cast<unsigned char>(text[2]) == 0xBF) {
        text.erase(0, 3);
    }
    if (text.rfind("\\uFEFF", 0) == 0) {
        text.erase(0, 6);
    }
    return text;
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
    if (name.empty() || value.empty()) return;
    const auto* current = std::getenv(name.c_str());
    if (current != nullptr && current[0] != '\0') return;
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
        if (name.size() >= 3
            && static_cast<unsigned char>(name[0]) == 0xEF
            && static_cast<unsigned char>(name[1]) == 0xBB
            && static_cast<unsigned char>(name[2]) == 0xBF) {
            name.erase(0, 3);
        }
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

bool get_bool(const std::string& json, const std::string& key, bool fallback = false) {
    auto raw = trim_copy(get_string(json, key, fallback ? "true" : "false"));
    for (auto& ch : raw) ch = static_cast<char>(std::toupper(static_cast<unsigned char>(ch)));
    if (raw == "TRUE" || raw == "1" || raw == "YES" || raw == "ON") return true;
    if (raw == "FALSE" || raw == "0" || raw == "NO" || raw == "OFF") return false;
    return fallback;
}

std::vector<std::string> get_string_array(const std::string& json, const std::string& key) {
    std::vector<std::string> values;
    const auto pattern = "\"" + key + "\"";
    auto pos = json.find(pattern);
    if (pos == std::string::npos) return values;
    pos = json.find(':', pos + pattern.size());
    if (pos == std::string::npos) return values;
    ++pos;
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) ++pos;
    if (pos >= json.size() || json[pos] != '[') return values;
    ++pos;
    while (pos < json.size()) {
        while (pos < json.size() && (std::isspace(static_cast<unsigned char>(json[pos])) || json[pos] == ',')) ++pos;
        if (pos >= json.size() || json[pos] == ']') break;
        if (json[pos] != '"') {
            while (pos < json.size() && json[pos] != ',' && json[pos] != ']') ++pos;
            continue;
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
        if (!out.empty()) values.push_back(out);
    }
    return values;
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
    // _popen invokes a shell, but Windows path quoting with redirection is
    // fragile when the executable path contains spaces. Use a nested cmd with
    // the documented /S quote rules so the child stdout remains attached to
    // the pipe and stderr redirection still works.
    return "cmd.exe /d /s /c \"" + command + "\"";
#else
    return command;
#endif
}

std::string upper_ascii(std::string value) {
    for (auto& ch : value) ch = static_cast<char>(std::toupper(static_cast<unsigned char>(ch)));
    return value;
}

std::string lower_ascii(std::string value) {
    for (auto& ch : value) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
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
    std::string execution_host{"127.0.0.1"};
    int execution_port{8011};
    fs::path root;
};

Args parse_args(int argc, char** argv) {
    Args args;
    args.port = env_port("CERIOUS_BACKEND_PORT", 8000);
    args.execution_port = env_port("CERIOUS_EXCHANGE_HTTP_PORT", 8011);
    args.root = fs::current_path();
    for (int i = 1; i < argc; ++i) {
        const std::string key = argv[i];
        auto next = [&]() -> std::string {
            if (i + 1 >= argc) return "";
            return argv[++i];
        };
        if (key == "--host") args.host = next();
        else if (key == "--port") args.port = std::stoi(next());
        else if (key == "--execution-host") args.execution_host = next();
        else if (key == "--execution-port") args.execution_port = std::stoi(next());
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

struct RegressionStudy {
    bool ok = false;
    std::string error;
    std::string symbol;
    std::string interval{"30m"};
    int lookback = 0;
    double standard_deviations = 0.0;
    int bars = 0;
    double mean = std::nan("");
    double upper = std::nan("");
    double lower = std::nan("");
    double sigma = std::nan("");
    double slope = std::nan("");
    double intercept = std::nan("");
    std::uint64_t updated_at = 0;
    bool includes_live_mark = false;
};

struct CachedRegressionStudy {
    RegressionStudy study;
    std::uint64_t fetched_at_ms = 0;
};

struct CachedMarketBars {
    std::vector<MarketBar> bars;
    std::uint64_t fetched_at_ms = 0;
};

struct AlgoCoverPolicy {
    std::string symbol;
    std::string strategy;
    std::string algo_id;
    std::string algo_name;
    int layer = 0;
    double cover_ticks = 0.0;
    double tick_size = 0.0;
};

struct CeriousAdvisorySnapshot {
    std::uint64_t fetched_at_ms = 0;
    bool ready = false;
    std::string intelligence;
    std::string daily_summary;
    std::string macro_regime;
    std::string opportunity_map;
};

struct Gateway {
    Args args;
    fs::path dist;
    fs::path data;
    std::atomic<bool> shutdown_requested{false};
    std::atomic<bool> market_data_running{false};
    mutable std::mutex market_mutex;
    mutable std::mutex study_cache_mutex;
    mutable std::mutex history_cache_mutex;
    std::unordered_map<std::string, MarketBook> market_books;
    std::unordered_map<std::string, std::deque<MarketTrade>> market_trades;
    mutable std::unordered_map<std::string, CachedRegressionStudy> regression_study_cache;
    mutable std::unordered_map<std::string, CachedMarketBars> history_bars_cache;
    mutable std::mutex algo_cover_mutex;
    mutable std::unordered_map<std::string, AlgoCoverPolicy> algo_cover_policies;
    mutable std::unordered_set<std::string> processed_sim_fill_events;
    mutable std::mutex cerious_advisory_mutex;
    mutable std::optional<CeriousAdvisorySnapshot> cerious_advisory_cache;
    mutable bool cerious_advisory_refreshing = false;
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
        return env_or("CERIOUS_ADMIN_PASSWORD", "12345678");
    }

    bool auth_pair_matches(const std::string& username, const std::string& password,
                           const std::string& expected_username, const std::string& expected_password) const {
        const auto clean_username = upper_ascii(trim_copy(username));
        const auto clean_expected_username = upper_ascii(trim_copy(expected_username));
        const auto clean_password = trim_copy(password);
        const auto clean_expected_password = trim_copy(expected_password);
        return !clean_expected_username.empty()
            && !clean_expected_password.empty()
            && clean_username == clean_expected_username
            && clean_password == clean_expected_password;
    }

    bool valid_login(const std::string& username, const std::string& password) const {
        return auth_pair_matches(username, password, portal_username(), portal_password())
            || auth_pair_matches(username, password, admin_username(), admin_password());
    }

    std::string auth_success_json(const std::string& username) const {
        const auto token = session_token();
        return "{\"ok\":true,\"username\":" + q(trim_copy(username))
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
            const auto command = pipe_command(shell_quote(exe)
                + " --symbols " + shell_quote_arg(market_data_symbols())
                + " --stype " + shell_quote_arg(market_data_stype())
                + " --stale-ms " + shell_quote_arg(market_data_stale_ms())
                + " --reconnect-ms " + shell_quote_arg(market_data_reconnect_ms())
                + " --max-reconnect-ms " + shell_quote_arg(market_data_max_reconnect_ms())
                + " 2>&1");
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
            if ((action == "T" || action == "F") && finite(price)) {
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
            publish_market_to_execution_exchange(update);
        }
    }

    void publish_market_to_execution_exchange(const MarketBook& book) const {
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
        auto result = execution_post("/market", body.str());
        if (result && result->status >= 200 && result->status < 300) {
            process_exchange_fill_events(result->body);
        }
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
            if (finite(out.bid) && finite(out.ask)) out.last = (out.bid + out.ask) / 2.0;
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
            << ",\"synthetic\":" << (spread_def_for(book.symbol) ? "true" : "false")
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
        if (finite(book.last)) {
            out << ",\"ltp\":" << book.last
                << ",\"ltpSize\":" << book.last_size
                << ",\"ltpSource\":" << q(spread_def_for(book.symbol) ? "synthetic_mid" : "mbp1_trade");
        }
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
        const auto exchange = execution_get("/health");
        const bool exchange_required = upper_ascii(env_or("CERIOUS_EXECUTION_DESTINATION", "cerious-exchange")) != "NONE";
        const bool exchange_ok = exchange && exchange->status >= 200 && exchange->status < 300;
        return "{\"ok\":true"
            ",\"destination\":\"cerious-exchange\""
            ",\"exchange\":\"cerious.exchange\""
            ",\"required\":" + std::string(exchange_required ? "true" : "false")
            + ",\"healthy\":" + std::string((!exchange_required || exchange_ok) ? "true" : "false")
            + ",\"stateOwner\":\"cerious.exchange\"}";
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

    struct ProcessResult {
        int exit_code = -1;
        std::string output;
    };

    static ProcessResult capture_process_result(const std::string& command) {
        ProcessResult result;
        FILE* pipe = open_process_pipe(pipe_command(command));
        if (!pipe) {
            result.output = "failed to start process";
            return result;
        }
        char buffer[8192];
        while (std::fgets(buffer, sizeof(buffer), pipe)) {
            result.output += buffer;
            if (result.output.size() > 16000) break;
        }
        result.exit_code = close_process_pipe(pipe);
        return result;
    }

    static std::string curl_config_quote(const std::string& value) {
        std::string out = "\"";
        for (const auto ch : value) {
            if (ch == '\\' || ch == '"') out.push_back('\\');
            if (ch == '\r' || ch == '\n') continue;
            out.push_back(ch);
        }
        out.push_back('"');
        return out;
    }

    static std::string strip_header_breaks(std::string value) {
        value.erase(std::remove(value.begin(), value.end(), '\r'), value.end());
        value.erase(std::remove(value.begin(), value.end(), '\n'), value.end());
        return trim_copy(value);
    }

    static bool email_destination_ok(const std::string& value) {
        if (value.empty() || value.size() > 254) return false;
        if (value.find_first_of(" \t\r\n<>") != std::string::npos) return false;
        const auto at = value.find('@');
        if (at == std::string::npos || at == 0 || at + 1 >= value.size()) return false;
        return value.find('.', at + 1) != std::string::npos;
    }

    bool alert_sms_dry_run() const {
        const auto value = lower_ascii(env_or("CERIOUS_ALERT_SMS_DRY_RUN", "1"));
        return value != "0" && value != "false" && value != "no" && value != "off";
    }

    std::string alert_smtp_status_json() const {
        const auto smtp_url = env_or("CERIOUS_ALERT_SMTP_URL", "");
        const auto smtp_from = env_or("CERIOUS_ALERT_SMTP_FROM", "");
        const auto smtp_user = env_or("CERIOUS_ALERT_SMTP_USERNAME", "");
        const auto smtp_password = env_or("CERIOUS_ALERT_SMTP_PASSWORD", "");
        const bool credentials_ok = smtp_user.empty() || !smtp_password.empty();
        const bool configured = !smtp_url.empty() && !smtp_from.empty() && credentials_ok;
        const bool dry_run = alert_sms_dry_run();
        std::string body = "{\"ok\":true"
            ",\"enabled\":true"
            ",\"runtime\":\"cpp\""
            ",\"provider\":\"smtp-email-to-sms\""
            ",\"transports\":[\"smtp\"]"
            ",\"dryRun\":" + std::string(dry_run ? "true" : "false")
            + ",\"configured\":" + std::string(configured ? "true" : "false")
            + ",\"ready\":" + std::string((dry_run || configured) ? "true" : "false");
        if (!dry_run && !configured) {
            body += ",\"error\":";
            body += q(credentials_ok
                ? "SMTP text alerts require CERIOUS_ALERT_SMTP_URL and CERIOUS_ALERT_SMTP_FROM"
                : "SMTP username is set but CERIOUS_ALERT_SMTP_PASSWORD is missing");
        }
        body += "}";
        return body;
    }

    std::optional<std::string> send_smtp_text_alert(const std::string& request_body, int& status) const {
        const auto to = strip_header_breaks(get_string(request_body, "to", ""));
        const auto message = get_string(request_body, "message", "Cerious alert");
        if (!email_destination_ok(to)) {
            status = 400;
            return std::string("{\"ok\":false,\"error\":\"SMS destination must be an email-to-SMS address\"}");
        }

        const auto smtp_url = env_or("CERIOUS_ALERT_SMTP_URL", "");
        const auto smtp_from = strip_header_breaks(env_or("CERIOUS_ALERT_SMTP_FROM", ""));
        const auto smtp_user = env_or("CERIOUS_ALERT_SMTP_USERNAME", "");
        const auto smtp_password = env_or("CERIOUS_ALERT_SMTP_PASSWORD", "");
        const bool credentials_ok = smtp_user.empty() || !smtp_password.empty();
        const bool configured = !smtp_url.empty() && !smtp_from.empty() && credentials_ok;
        const bool dry_run = alert_sms_dry_run();

        if (dry_run) {
            status = 200;
            return "{\"ok\":true,\"queued\":true,\"provider\":\"smtp-email-to-sms\",\"dryRun\":true,\"runtime\":\"cpp\",\"message\":\"SMTP dry-run accepted\"}";
        }
        if (!configured) {
            status = 503;
            return alert_smtp_status_json();
        }
        if (!email_destination_ok(smtp_from)) {
            status = 503;
            return std::string("{\"ok\":false,\"configured\":false,\"provider\":\"smtp-email-to-sms\",\"error\":\"CERIOUS_ALERT_SMTP_FROM must be an email address\"}");
        }

        const auto curl_path = env_or("CERIOUS_ALERT_CURL_PATH",
#ifdef _WIN32
            "curl.exe"
#else
            "curl"
#endif
        );

        static std::atomic<unsigned long long> smtp_counter{0};
        const auto nonce = std::to_string(now_ms()) + "-" + std::to_string(++smtp_counter);
        const auto temp_base = fs::temp_directory_path() / ("cerious-alert-" + nonce);
        const auto message_path = temp_base.string() + ".eml";
        const auto config_path = temp_base.string() + ".curl";

        std::ostringstream email;
        email << "From: " << smtp_from << "\r\n"
              << "To: " << to << "\r\n"
              << "Subject: Cerious Alert\r\n"
              << "Content-Type: text/plain; charset=utf-8\r\n"
              << "\r\n"
              << message << "\r\n";

        std::ostringstream curl_config;
        curl_config << "url = " << curl_config_quote(smtp_url) << "\n"
                    << "ssl-reqd\n"
                    << "mail-from = " << curl_config_quote("<" + smtp_from + ">") << "\n"
                    << "mail-rcpt = " << curl_config_quote("<" + to + ">") << "\n"
                    << "upload-file = " << curl_config_quote(message_path) << "\n"
                    << "connect-timeout = 15\n"
                    << "max-time = 30\n"
                    << "silent\n"
                    << "show-error\n";
        if (!smtp_user.empty()) {
            curl_config << "user = " << curl_config_quote(smtp_user + ":" + smtp_password) << "\n";
        }

        if (!write_text(fs::path(message_path), email.str()) || !write_text(fs::path(config_path), curl_config.str())) {
            status = 500;
            std::error_code ec;
            fs::remove(message_path, ec);
            fs::remove(config_path, ec);
            return std::string("{\"ok\":false,\"provider\":\"smtp-email-to-sms\",\"error\":\"failed to stage SMTP alert\"}");
        }

        const auto command = shell_quote(fs::path(curl_path)) + " --config " + shell_quote(fs::path(config_path)) + " 2>&1";
        const auto result = capture_process_result(command);
        std::error_code ec;
        fs::remove(message_path, ec);
        fs::remove(config_path, ec);
        if (result.exit_code == 0) {
            status = 200;
            return std::string("{\"ok\":true,\"queued\":true,\"provider\":\"smtp-email-to-sms\",\"dryRun\":false,\"runtime\":\"cpp\"}");
        }

        status = 502;
        const auto detail = result.output.substr(0, 1000);
        const auto detail_lower = lower_ascii(detail);
        std::string error = "SMTP send failed";
        std::string hint;
        if (result.exit_code == 67 || detail_lower.find("login denied") != std::string::npos
            || detail_lower.find("authentication") != std::string::npos) {
            error = "SMTP authentication failed";
            hint = "Gmail usually requires a Gmail App Password for SMTP; the normal account password is rejected.";
        } else if (detail_lower.find("could not resolve") != std::string::npos
            || detail_lower.find("couldn't resolve") != std::string::npos) {
            error = "SMTP host lookup failed";
            hint = "Check CERIOUS_ALERT_SMTP_URL.";
        } else if (detail_lower.find("timed out") != std::string::npos
            || detail_lower.find("timeout") != std::string::npos) {
            error = "SMTP connection timed out";
            hint = "Check network access to the SMTP host and port.";
        }

        std::string body = "{\"ok\":false,\"queued\":false,\"provider\":\"smtp-email-to-sms\",\"dryRun\":false,\"runtime\":\"cpp\""
            ",\"error\":" + q(error)
            + ",\"exitCode\":" + std::to_string(result.exit_code)
            + ",\"detail\":" + q(detail);
        if (!hint.empty()) body += ",\"hint\":" + q(hint);
        body += "}";
        return body;
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

    std::int64_t chart_time_seconds(std::uint64_t timestamp_ms, const std::string& interval) const {
        const auto seconds = static_cast<std::int64_t>(timestamp_ms / 1000ULL);
        const auto minutes = std::max(1, interval_minutes(interval));
        if (minutes >= 1440) return seconds - (seconds % 86400);
        const auto interval_seconds = static_cast<std::int64_t>(minutes) * 60;
        return seconds - (seconds % interval_seconds);
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
        const auto normalized_limit = std::max(1, limit);
        const auto cache_key = symbol + "|" + lower_ascii(interval) + "|" + std::to_string(normalized_limit);
        std::uint64_t ttl_ms = 20000;
        try {
            ttl_ms = std::stoull(env_or("CERIOUS_CHART_HISTORY_CACHE_MS", "20000"));
        } catch (...) {
            ttl_ms = 20000;
        }
        const auto request_started_ms = now_ms();
        auto cached_bars = [&]() -> std::optional<std::vector<MarketBar>> {
            std::lock_guard<std::mutex> lock(history_cache_mutex);
            const auto cached = history_bars_cache.find(cache_key);
            if (cached != history_bars_cache.end() && !cached->second.bars.empty()) return cached->second.bars;

            const auto prefix = symbol + "|" + lower_ascii(interval) + "|";
            const CachedMarketBars* best = nullptr;
            for (const auto& [key, value] : history_bars_cache) {
                if (key.rfind(prefix, 0) != 0 || value.bars.empty()) continue;
                if (value.bars.size() < static_cast<std::size_t>(normalized_limit)) continue;
                if (!best || value.bars.size() < best->bars.size()) best = &value;
            }
            if (!best) return std::nullopt;
            auto bars = best->bars;
            if (bars.size() > static_cast<std::size_t>(normalized_limit)) {
                bars.erase(bars.begin(), bars.end() - normalized_limit);
            }
            return bars;
        };
        {
            std::lock_guard<std::mutex> lock(history_cache_mutex);
            const auto cached = history_bars_cache.find(cache_key);
            if (cached != history_bars_cache.end() && !cached->second.bars.empty()) {
                const auto age_ms = request_started_ms >= cached->second.fetched_at_ms
                    ? request_started_ms - cached->second.fetched_at_ms
                    : 0;
                if (age_ms <= ttl_ms) return cached->second.bars;
            }
            const auto prefix = symbol + "|" + lower_ascii(interval) + "|";
            const CachedMarketBars* best = nullptr;
            for (const auto& [key, value] : history_bars_cache) {
                if (key.rfind(prefix, 0) != 0 || value.bars.empty()) continue;
                if (value.bars.size() < static_cast<std::size_t>(normalized_limit)) continue;
                const auto age_ms = request_started_ms >= value.fetched_at_ms
                    ? request_started_ms - value.fetched_at_ms
                    : 0;
                if (age_ms > ttl_ms) continue;
                if (!best || value.bars.size() < best->bars.size()) best = &value;
            }
            if (best) {
                auto bars = best->bars;
                if (bars.size() > static_cast<std::size_t>(normalized_limit)) {
                    bars.erase(bars.begin(), bars.end() - normalized_limit);
                }
                return bars;
            }
        }
        const auto exe = price_history_exe();
        if (!fs::exists(exe)) {
            std::cerr << "history unavailable: native price history executable not found at "
                      << exe.string() << std::endl;
            if (auto cached = cached_bars()) return *cached;
            return {};
        }
        if (env_or("DATABENTO_API_KEY", "").empty()) {
            std::cerr << "history unavailable: DATABENTO_API_KEY is not configured in gateway process" << std::endl;
            if (auto cached = cached_bars()) return *cached;
            return {};
        }
        const auto schema = history_schema_for_interval(interval);
        const auto minutes = std::max(1, interval_minutes(interval));
        const auto records_per_bar = schema == "ohlcv-1m" ? minutes : 1;
        const auto fetch_limit = std::max(normalized_limit * records_per_bar + records_per_bar * 4, normalized_limit + 20);
        const auto schema_minutes = schema == "ohlcv-1h" ? 60 : schema == "ohlcv-1d" ? 1440 : 1;
        const auto now = std::chrono::system_clock::now();
        std::chrono::system_clock::time_point end_time;
        if (schema == "ohlcv-1d") {
            const auto epoch_seconds = std::chrono::duration_cast<std::chrono::seconds>(
                now.time_since_epoch()).count();
            end_time = std::chrono::system_clock::time_point(
                std::chrono::seconds((epoch_seconds / 86400) * 86400));
        } else {
            end_time = std::chrono::time_point_cast<std::chrono::minutes>(
                now - std::chrono::minutes(16));
        }
        const auto lookback_minutes = std::max(1, fetch_limit) * schema_minutes;
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
        bars = aggregate_bars(std::move(bars), minutes, normalized_limit);
        if (bars.size() > static_cast<std::size_t>(normalized_limit)) {
            bars.erase(bars.begin(), bars.end() - normalized_limit);
        }
        if (!bars.empty()) {
            std::lock_guard<std::mutex> lock(history_cache_mutex);
            history_bars_cache[cache_key] = CachedMarketBars{bars, now_ms()};
        } else if (auto cached = cached_bars()) {
            return *cached;
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

    std::vector<MarketBar> cached_history_bars_for_symbol(const std::string& raw_symbol, const std::string& interval, int limit) const {
        const auto symbol = canonical_market_symbol(raw_symbol);
        const auto normalized_limit = std::max(1, limit);
        const auto interval_key = lower_ascii(interval);
        const auto cache_key = symbol + "|" + interval_key + "|" + std::to_string(normalized_limit);
        std::lock_guard<std::mutex> lock(history_cache_mutex);

        auto tail = [&](std::vector<MarketBar> bars) {
            if (bars.size() > static_cast<std::size_t>(normalized_limit)) {
                bars.erase(bars.begin(), bars.end() - normalized_limit);
            }
            return bars;
        };

        const auto exact = history_bars_cache.find(cache_key);
        if (exact != history_bars_cache.end() && !exact->second.bars.empty()) {
            return tail(exact->second.bars);
        }

        const auto prefix = symbol + "|" + interval_key + "|";
        const CachedMarketBars* best = nullptr;
        for (const auto& [key, value] : history_bars_cache) {
            if (key.rfind(prefix, 0) != 0 || value.bars.empty()) continue;
            if (value.bars.size() < static_cast<std::size_t>(normalized_limit)) continue;
            if (!best || value.bars.size() < best->bars.size()) best = &value;
        }
        return best ? tail(best->bars) : std::vector<MarketBar>{};
    }

    std::vector<MarketBar> cached_history_bars(const std::string& raw_symbol, const std::string& interval, int limit) const {
        const auto symbol = canonical_market_symbol(raw_symbol);
        if (const auto spread = spread_def_for(symbol)) {
            auto left = cached_history_bars_for_symbol(spread->left, interval, limit);
            auto right = cached_history_bars_for_symbol(spread->right, interval, limit);
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
        return cached_history_bars_for_symbol(symbol, interval, limit);
    }

    std::vector<MarketBar> study_bars_with_live_mark(const std::string& raw_symbol, const std::string& interval, int limit, bool* includes_live_mark = nullptr) const {
        const auto symbol = canonical_market_symbol(raw_symbol);
        const auto minutes = std::max(1, interval_minutes(interval));
        const auto bucket_ms = static_cast<std::uint64_t>(minutes) * 60ULL * 1000ULL;
        auto bars = history_bars(symbol, interval, std::max(1, limit));
        if (includes_live_mark) *includes_live_mark = false;

        const auto book = current_book(symbol);
        if (book) {
            const auto live_mark = mid_or_last(*book);
            if (finite(live_mark)) {
                const auto source_ts = book->ts_ms ? book->ts_ms : now_ms();
                const auto live_bucket = (source_ts / bucket_ms) * bucket_ms;
                if (!bars.empty() && bars.back().timestamp == live_bucket) {
                    auto& active = bars.back();
                    active.high = std::max(active.high, live_mark);
                    active.low = std::min(active.low, live_mark);
                    active.close = live_mark;
                } else {
                    MarketBar active;
                    active.timestamp = live_bucket;
                    active.open = live_mark;
                    active.high = live_mark;
                    active.low = live_mark;
                    active.close = live_mark;
                    active.volume = 0;
                    bars.push_back(active);
                }
                if (includes_live_mark) *includes_live_mark = true;
            }
        }

        std::sort(bars.begin(), bars.end(), [](const MarketBar& left, const MarketBar& right) {
            return left.timestamp < right.timestamp;
        });
        if (bars.size() > static_cast<std::size_t>(limit)) {
            bars.erase(bars.begin(), bars.end() - limit);
        }
        return bars;
    }

    RegressionStudy calculate_regression_study(const std::string& raw_symbol, const std::string& raw_interval, int raw_lookback, double raw_standard_deviations) const {
        RegressionStudy study;
        study.symbol = canonical_market_symbol(raw_symbol);
        study.interval = raw_interval.empty() ? std::string("30m") : raw_interval;
        if (raw_lookback < 2) {
            study.error = "regression lookback is required";
            return study;
        }
        study.lookback = std::clamp(raw_lookback, 2, 2000);
        study.standard_deviations = std::clamp(raw_standard_deviations, 0.0, 20.0);
        const auto cache_key = study.symbol + "|" + lower_ascii(study.interval) + "|"
            + std::to_string(study.lookback) + "|" + json_number(study.standard_deviations, 4);
        const auto cache_now = now_ms();
        {
            std::lock_guard<std::mutex> lock(study_cache_mutex);
            const auto cached = regression_study_cache.find(cache_key);
            if (cached != regression_study_cache.end()) {
                const auto age_ms = cache_now >= cached->second.fetched_at_ms
                    ? cache_now - cached->second.fetched_at_ms
                    : 0;
                const auto ttl_ms = cached->second.study.ok ? 60000ULL : 5000ULL;
                if (age_ms <= ttl_ms) return cached->second.study;
            }
        }

        auto cache_result = [&](const RegressionStudy& result) {
            std::lock_guard<std::mutex> lock(study_cache_mutex);
            regression_study_cache[cache_key] = CachedRegressionStudy{result, now_ms()};
            return result;
        };

        bool includes_live = false;
        // Synthetic spreads can lose bars when leg timestamps do not overlap exactly.
        // Use the same deep history window that charts consume so every subscriber
        // resolves the regression from one server-side study source.
        const auto study_limit = std::clamp(std::max(study.lookback + 8, study.lookback * 6), study.lookback, 1200);
        const auto bars = study_bars_with_live_mark(study.symbol, study.interval, study_limit, &includes_live);
        study.includes_live_mark = includes_live;
        study.bars = static_cast<int>(bars.size());
        if (bars.size() < static_cast<std::size_t>(study.lookback)) {
            study.error = "not enough bars for requested regression lookback";
            return cache_result(study);
        }

        const auto first = bars.size() - static_cast<std::size_t>(study.lookback);
        const auto n = static_cast<double>(study.lookback);
        const auto x_mean = (n - 1.0) / 2.0;
        double y_sum = 0.0;
        for (std::size_t i = first; i < bars.size(); ++i) {
            if (!finite(bars[i].close)) {
                study.error = "non-finite close in regression sample";
                return cache_result(study);
            }
            y_sum += bars[i].close;
        }

        const auto y_mean = y_sum / n;
        double numerator = 0.0;
        double denominator = 0.0;
        for (int i = 0; i < study.lookback; ++i) {
            const auto y = bars[first + static_cast<std::size_t>(i)].close;
            const auto x_delta = static_cast<double>(i) - x_mean;
            numerator += x_delta * (y - y_mean);
            denominator += x_delta * x_delta;
        }
        study.slope = denominator != 0.0 ? numerator / denominator : 0.0;
        study.intercept = y_mean - study.slope * x_mean;

        double residual_sq_sum = 0.0;
        for (int i = 0; i < study.lookback; ++i) {
            const auto y = bars[first + static_cast<std::size_t>(i)].close;
            const auto fitted = study.intercept + study.slope * static_cast<double>(i);
            const auto residual = y - fitted;
            residual_sq_sum += residual * residual;
        }
        study.sigma = std::sqrt(residual_sq_sum / n);
        study.mean = study.intercept + study.slope * static_cast<double>(study.lookback - 1);
        study.upper = study.mean + study.standard_deviations * study.sigma;
        study.lower = study.mean - study.standard_deviations * study.sigma;
        study.updated_at = bars.back().timestamp;
        study.ok = finite(study.mean) && finite(study.upper) && finite(study.lower);
        if (!study.ok) study.error = "regression calculation unavailable";
        return cache_result(study);
    }

    std::string regression_study_json(const std::string& raw_symbol, const std::string& interval, int lookback, double standard_deviations) const {
        const auto study = calculate_regression_study(raw_symbol, interval, lookback, standard_deviations);
        std::ostringstream out;
        out << std::fixed << std::setprecision(9)
            << "{\"ok\":" << (study.ok ? "true" : "false")
            << ",\"runtime\":\"cpp\",\"source\":\"cerious-study-service\",\"study\":\"linear-regression\""
            << ",\"symbol\":" << q(study.symbol)
            << ",\"interval\":" << q(study.interval)
            << ",\"lookback\":" << study.lookback
            << ",\"standardDeviations\":" << study.standard_deviations
            << ",\"bars\":" << study.bars
            << ",\"includesLiveMark\":" << (study.includes_live_mark ? "true" : "false")
            << ",\"updatedAt\":" << study.updated_at
            << ",\"updatedTime\":" << (study.updated_at ? chart_time_seconds(study.updated_at, study.interval) : 0);
        if (study.ok) {
            out << ",\"mean\":" << study.mean
                << ",\"upper\":" << study.upper
                << ",\"lower\":" << study.lower
                << ",\"sigma\":" << study.sigma
                << ",\"slope\":" << study.slope
                << ",\"intercept\":" << study.intercept
                << ",\"label\":" << q("Linear Regression lookback " + std::to_string(study.lookback) + " " + study.interval);
        } else {
            out << ",\"error\":" << q(study.error.empty() ? "regression unavailable" : study.error);
        }
        out << "}";
        return out.str();
    }

    std::string bars_json(const std::string& raw_symbol, const std::string& interval, int limit) const {
        const auto symbol = canonical_market_symbol(raw_symbol);
        bool includes_live = false;
        const auto requested_limit = std::max(1, limit);
        const auto warm_limit = interval_minutes(interval) >= 1440 ? 140 : 300;
        const auto internal_limit = std::clamp(std::max(requested_limit, warm_limit), requested_limit, 1200);
        auto bars = study_bars_with_live_mark(symbol, interval, internal_limit, &includes_live);
        if (bars.size() > static_cast<std::size_t>(requested_limit)) {
            bars.erase(bars.begin(), bars.end() - requested_limit);
        }
        std::ostringstream out;
        out << std::fixed << std::setprecision(9)
            << "{\"ok\":true,\"runtime\":\"cpp\",\"source\":\"databento-historical-cpp\",\"symbol\":" << q(symbol)
            << ",\"includesLiveMark\":" << (includes_live ? "true" : "false")
            << ",\"lastBarTimestamp\":" << (bars.empty() ? 0 : bars.back().timestamp)
            << ",\"bars\":[";
        for (std::size_t i = 0; i < bars.size(); ++i) {
            const auto& bar = bars[i];
            const auto chart_seconds = chart_time_seconds(bar.timestamp, interval);
            if (i) out << ",";
            out << "{\"time\":" << chart_seconds
                << ",\"timestamp\":" << bar.timestamp
                << ",\"timestampMs\":" << bar.timestamp
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

    struct AdvisorySpreadStat {
        std::string key;
        std::string label;
        double spread = std::nan("");
        double last = std::nan("");
        double bid = std::nan("");
        double ask = std::nan("");
        double mean20 = std::nan("");
        double mean30 = std::nan("");
        double weekly_mean = std::nan("");
        double short_term_mean = std::nan("");
        int short_term_bars = 0;
        std::string short_term_interval{"30m"};
        double prior_mean20 = std::nan("");
        double prior_settle = std::nan("");
        double atr3 = std::nan("");
        double atr20 = std::nan("");
        double atr30 = std::nan("");
        double blended_atr = std::nan("");
        double vwap_basis = std::nan("");
        double z = 0.0;
        double day_z = 0.0;
        int order_flow_score = 0;
        int score = 0;
        bool live = false;
        std::uint64_t rv_updated_at = 0;
        RegressionStudy regression;
        std::vector<MarketBar> bars;
    };

    static std::string spread_label(const std::string& symbol) {
        auto label = symbol;
        std::replace(label.begin(), label.end(), '_', '/');
        return label;
    }

    static std::string spread_expression(const std::string& symbol) {
        if (symbol == "ES_NQ") return "Buy ES / sell NQ when the spread re-enters from below the band.";
        if (symbol == "RTY_ES") return "Buy RTY / sell ES only if rates and credit do not deteriorate.";
        if (symbol == "YM_ES") return "Long YM / short ES if Dow leadership confirms.";
        return "Use the relative-value signal only after macro and order-flow confirmation.";
    }

    static std::string spread_risk_read(const std::string& symbol) {
        if (symbol == "ES_NQ") return "Avoid premature fades when Nasdaq momentum persists.";
        if (symbol == "RTY_ES") return "Small-cap cheap can stay cheap in risk-off regimes.";
        if (symbol == "YM_ES") return "Often defensive value, not true risk-on.";
        return "Respect volatility expansion and confirm liquidity before sizing.";
    }

    static std::string spread_signal(double z) {
        if (z <= -1.5) return "Buy spread setup";
        if (z >= 1.5) return "Sell spread setup";
        if (z <= -1.0) return "Cheap watch; wait for reclaim";
        if (z >= 1.0) return "Rich watch; wait for fade";
        if (std::abs(z) < 0.5) return "Neutral / fair value";
        return z > 0 ? "Rich, wait or fade" : "Cheap, wait or confirm";
    }

    static double close_mean(const std::vector<MarketBar>& bars, std::size_t count, std::size_t skip_tail = 0) {
        if (bars.empty() || skip_tail >= bars.size()) return std::nan("");
        const auto end = bars.size() - skip_tail;
        const auto begin = end > count ? end - count : 0;
        if (begin >= end) return std::nan("");
        double sum = 0.0;
        int n = 0;
        for (std::size_t i = begin; i < end; ++i) {
            if (!finite(bars[i].close)) continue;
            sum += bars[i].close;
            ++n;
        }
        return n ? sum / static_cast<double>(n) : std::nan("");
    }

    static double average_true_range(const std::vector<MarketBar>& bars, std::size_t count) {
        if (bars.empty()) return std::nan("");
        const auto begin = bars.size() > count ? bars.size() - count : 0;
        double sum = 0.0;
        int n = 0;
        for (std::size_t i = begin; i < bars.size(); ++i) {
            const auto prev_close = i > 0 ? bars[i - 1].close : bars[i].open;
            const auto tr = std::max({
                bars[i].high - bars[i].low,
                std::abs(bars[i].high - prev_close),
                std::abs(bars[i].low - prev_close),
            });
            if (!finite(tr)) continue;
            sum += std::abs(tr);
            ++n;
        }
        return n ? sum / static_cast<double>(n) : std::nan("");
    }

    std::uint64_t advisory_refresh_ms() const {
        try {
            return std::clamp<std::uint64_t>(
                static_cast<std::uint64_t>(std::stoull(env_or("CERIOUS_ADVISORY_REFRESH_MS", "1800000"))),
                60000ULL,
                86400000ULL);
        } catch (...) {
            return 1800000ULL;
        }
    }

    std::optional<int> advisory_regression_lookback() const {
        const auto configured = trim_copy(env_or("CERIOUS_ADVISORY_REGRESSION_LOOKBACK", ""));
        if (configured.empty()) return std::nullopt;
        try {
            return std::clamp(std::stoi(configured), 2, 2000);
        } catch (...) {
            return std::nullopt;
        }
    }

    double advisory_regression_std_dev() const {
        try {
            return std::clamp(std::stod(env_or("CERIOUS_ADVISORY_REGRESSION_STD_DEV", "2")), 0.0, 20.0);
        } catch (...) {
            return 2.0;
        }
    }

    std::string advisory_regression_interval() const {
        const auto value = trim_copy(env_or("CERIOUS_ADVISORY_REGRESSION_INTERVAL", "30m"));
        return value.empty() ? std::string("30m") : value;
    }

    int advisory_daily_lookback_days() const {
        try {
            return std::clamp(std::stoi(env_or("CERIOUS_ADVISORY_DAILY_LOOKBACK_DAYS", "20")), 5, 252);
        } catch (...) {
            return 20;
        }
    }

    int advisory_long_lookback_days() const {
        try {
            return std::clamp(std::stoi(env_or("CERIOUS_ADVISORY_LONG_LOOKBACK_DAYS", "30")), 10, 252);
        } catch (...) {
            return 30;
        }
    }

    int advisory_short_lookback_bars() const {
        try {
            return std::clamp(std::stoi(env_or("CERIOUS_ADVISORY_SHORT_LOOKBACK_BARS", "13")), 2, 240);
        } catch (...) {
            return 13;
        }
    }

    std::optional<RegressionStudy> cached_regression_study(const std::string& raw_symbol, const std::string& raw_interval, int raw_lookback, double raw_standard_deviations) const {
        const auto symbol = canonical_market_symbol(raw_symbol);
        const auto interval = raw_interval.empty() ? std::string("30m") : raw_interval;
        const auto lookback = std::clamp(raw_lookback, 2, 2000);
        const auto standard_deviations = std::clamp(raw_standard_deviations, 0.0, 20.0);
        const auto cache_key = symbol + "|" + lower_ascii(interval) + "|"
            + std::to_string(lookback) + "|" + json_number(standard_deviations, 4);
        std::lock_guard<std::mutex> lock(study_cache_mutex);
        const auto cached = regression_study_cache.find(cache_key);
        if (cached == regression_study_cache.end()) return std::nullopt;
        return cached->second.study;
    }

    AdvisorySpreadStat build_advisory_spread_stat(const SpreadDef& spread, bool allow_history_fetch) const {
        AdvisorySpreadStat stat;
        stat.key = spread.symbol;
        stat.label = spread_label(spread.symbol);
        const auto daily_lookback = advisory_daily_lookback_days();
        const auto long_lookback = advisory_long_lookback_days();
        const auto short_interval = advisory_regression_interval();
        const auto short_lookback = advisory_short_lookback_bars();
        const auto regression_lookback = advisory_regression_lookback();
        const auto regression_std_dev = advisory_regression_std_dev();
        stat.bars = allow_history_fetch
            ? history_bars(spread.symbol, "1d", std::max(120, long_lookback + 20))
            : cached_history_bars(spread.symbol, "1d", std::max(120, long_lookback + 20));
        const auto short_bar_limit = regression_lookback
            ? std::max(*regression_lookback + 8, 240)
            : 240;
        const auto short_bars = allow_history_fetch
            ? history_bars(spread.symbol, short_interval, short_bar_limit)
            : cached_history_bars(spread.symbol, short_interval, short_bar_limit);
        stat.short_term_interval = short_interval;
        stat.short_term_bars = static_cast<int>(short_bars.size());
        stat.short_term_mean = close_mean(short_bars, static_cast<std::size_t>(short_lookback));
        if (regression_lookback) {
            if (allow_history_fetch) {
                stat.regression = calculate_regression_study(spread.symbol, short_interval, *regression_lookback, regression_std_dev);
            } else if (auto cached = cached_regression_study(spread.symbol, short_interval, *regression_lookback, regression_std_dev)) {
                stat.regression = *cached;
            }
        }
        std::string rv_interval = "1d";
        if (stat.bars.size() < 20) {
            stat.bars = allow_history_fetch
                ? history_bars(spread.symbol, "30m", 240)
                : cached_history_bars(spread.symbol, "30m", 240);
            rv_interval = "30m";
        }
        if (stat.bars.size() > 60) {
            stat.bars.erase(stat.bars.begin(), stat.bars.end() - 60);
        }

        const auto book = current_book(spread.symbol);
        if (book) {
            stat.bid = book->bid;
            stat.ask = book->ask;
            stat.last = mid_or_last(*book);
            stat.live = book->live;
            stat.rv_updated_at = book->ts_ms;
        }
        if ((!finite(stat.last) || stat.last == 0.0) && !stat.bars.empty()) {
            stat.last = stat.bars.back().close;
        }
        stat.spread = stat.last;
        if (!stat.rv_updated_at && !stat.bars.empty()) stat.rv_updated_at = stat.bars.back().timestamp;
        if (finite(stat.last) && (stat.bars.empty() || stat.bars.back().close != stat.last)) {
            MarketBar live_bar;
            live_bar.timestamp = stat.rv_updated_at ? stat.rv_updated_at : now_ms();
            live_bar.open = stat.last;
            live_bar.high = stat.last;
            live_bar.low = stat.last;
            live_bar.close = stat.last;
            live_bar.volume = 0;
            stat.bars.push_back(live_bar);
            if (stat.bars.size() > 60) stat.bars.erase(stat.bars.begin());
        }

        stat.mean20 = close_mean(stat.bars, static_cast<std::size_t>(daily_lookback));
        stat.mean30 = close_mean(stat.bars, static_cast<std::size_t>(long_lookback));
        stat.weekly_mean = close_mean(stat.bars, 5);
        stat.prior_mean20 = close_mean(stat.bars, static_cast<std::size_t>(daily_lookback), 1);
        stat.prior_settle = stat.bars.size() > 1 ? stat.bars[stat.bars.size() - 2].close : close_mean(stat.bars, 1);
        stat.atr3 = average_true_range(stat.bars, 3);
        stat.atr20 = average_true_range(stat.bars, 20);
        stat.atr30 = average_true_range(stat.bars, 30);
        if (!finite(stat.mean20)) stat.mean20 = stat.last;
        if (!finite(stat.mean30)) stat.mean30 = stat.mean20;
        if (!finite(stat.weekly_mean)) stat.weekly_mean = stat.mean20;
        if (!finite(stat.short_term_mean)) stat.short_term_mean = stat.mean20;
        if (!finite(stat.prior_mean20)) stat.prior_mean20 = stat.mean20;
        if (!finite(stat.prior_settle)) stat.prior_settle = stat.last;
        if (!finite(stat.atr3)) stat.atr3 = 0.0;
        if (!finite(stat.atr20)) stat.atr20 = stat.atr3;
        if (!finite(stat.atr30)) stat.atr30 = stat.atr20;
        stat.blended_atr = finite(stat.atr20) && finite(stat.atr30)
            ? (stat.atr20 * 0.65 + stat.atr30 * 0.35)
            : std::max(stat.atr20, stat.atr30);
        const auto min_width = std::max(product_def_for(spread.symbol).tick_size * 4.0, 0.0001);
        if (!finite(stat.blended_atr) || stat.blended_atr < min_width) stat.blended_atr = min_width;
        stat.vwap_basis = finite(stat.prior_settle) ? stat.prior_settle : stat.mean20;
        stat.z = finite(stat.last) ? (stat.last - stat.mean20) / stat.blended_atr : 0.0;
        const auto half_atr = std::max(stat.blended_atr / 2.0, min_width);
        stat.day_z = finite(stat.last) ? (stat.last - stat.vwap_basis) / half_atr : stat.z;
        stat.order_flow_score = std::clamp(static_cast<int>(std::llround(std::abs(stat.day_z) * 38.0 + std::abs(stat.z) * 18.0)), 0, 100);
        stat.score = std::clamp(40 + static_cast<int>(std::llround(std::abs(stat.z) * 28.0 + std::abs(stat.day_z) * 18.0)) + (stat.live ? 8 : 0), 0, 100);
        (void)rv_interval;
        return stat;
    }

    std::vector<AdvisorySpreadStat> build_advisory_spread_stats(bool allow_history_fetch) const {
        std::vector<AdvisorySpreadStat> stats;
        for (const auto& spread : spread_definitions()) {
            stats.push_back(build_advisory_spread_stat(spread, allow_history_fetch));
        }
        std::sort(stats.begin(), stats.end(), [](const auto& left, const auto& right) {
            return left.score > right.score;
        });
        return stats;
    }

    std::string advisory_spread_json(const AdvisorySpreadStat& stat, bool include_bars = true) const {
        const auto move = finite(stat.last) && finite(stat.mean20) ? stat.last - stat.mean20 : std::nan("");
        const auto move_pct = stat.blended_atr > 0.0 && finite(move) ? move / stat.blended_atr : 0.0;
        const auto half_atr = stat.blended_atr / 2.0;
        const auto regression_lookback_json = stat.regression.ok && stat.regression.lookback > 0
            ? std::to_string(stat.regression.lookback)
            : std::string("null");
        const auto regression_bars_json = stat.regression.ok
            ? std::to_string(stat.regression.bars)
            : std::string("0");
        std::ostringstream out;
        out << "{\"key\":" << q(stat.key)
            << ",\"label\":" << q(stat.label)
            << ",\"spread\":" << json_number(stat.spread, 4)
            << ",\"lastTraded\":" << json_number(stat.last, 4)
            << ",\"mean\":" << json_number(stat.mean20, 4)
            << ",\"longTermMean\":" << json_number(stat.mean30, 4)
            << ",\"weeklyMean\":" << json_number(stat.weekly_mean, 4)
            << ",\"shortTermMean\":" << json_number(stat.short_term_mean, 4)
            << ",\"shortTermInterval\":" << q(stat.short_term_interval)
            << ",\"shortTermBars\":" << stat.short_term_bars
            << ",\"lookbackMean\":" << json_number(stat.mean20, 4)
            << ",\"priorLookbackMean\":" << json_number(stat.prior_mean20, 4)
            << ",\"lookbackDays\":" << advisory_daily_lookback_days()
            << ",\"priorSettle\":" << json_number(stat.prior_settle, 4)
            << ",\"moveFromMean\":" << json_number(move, 4)
            << ",\"movePctOfAtr\":" << json_number(move_pct, 4)
            << ",\"atr\":" << json_number(stat.blended_atr, 4)
            << ",\"atr3\":" << json_number(stat.atr3, 4)
            << ",\"atr20\":" << json_number(stat.atr20, 4)
            << ",\"atr30\":" << json_number(stat.atr30, 4)
            << ",\"blendedAtr\":" << json_number(stat.blended_atr, 4)
            << ",\"halfAtr\":" << json_number(half_atr, 4)
            << ",\"vwapBasis\":" << json_number(stat.vwap_basis, 4)
            << ",\"dayZ\":" << json_number(stat.day_z, 4)
            << ",\"z\":" << json_number(stat.z, 4)
            << ",\"rawZ\":" << json_number(stat.z, 4)
            << ",\"signalThreshold\":1.5"
            << ",\"bias\":" << q(stat.z <= -0.5 ? "buy" : stat.z >= 0.5 ? "sell" : "neutral")
            << ",\"orderFlowScore\":" << stat.order_flow_score
            << ",\"updateCadence\":\"Daily baseline plus completed 30m study bars; live last-trade overlay\""
            << ",\"rvInterval\":\"1d\""
            << ",\"rvBars\":" << stat.bars.size()
            << ",\"rvUpdatedAt\":" << stat.rv_updated_at
            << ",\"publishedAt\":" << q(utc_iso(std::chrono::system_clock::now()) + "Z")
            << ",\"publishReason\":\"Native Cerious advisory snapshot from live book and historical bars\""
            << ",\"linearRegressionMean\":" << json_number(stat.regression.mean, 4)
            << ",\"linearRegressionUpper\":" << json_number(stat.regression.upper, 4)
            << ",\"linearRegressionLower\":" << json_number(stat.regression.lower, 4)
            << ",\"linearRegressionSigma\":" << json_number(stat.regression.sigma, 4)
            << ",\"linearRegressionSlope\":" << json_number(stat.regression.slope, 8)
            << ",\"linearRegressionInterval\":" << q(stat.regression.interval.empty() ? advisory_regression_interval() : stat.regression.interval)
            << ",\"linearRegressionLookback\":" << regression_lookback_json
            << ",\"linearRegressionBars\":" << regression_bars_json
            << ",\"linearRegressionUpdatedAt\":" << stat.regression.updated_at
            << ",\"linearRegressionIsForming\":" << (stat.regression.includes_live_mark ? "true" : "false")
            << ",\"linearRegressionSource\":\"cerious-study-service\""
            << ",\"linearRegressionReady\":" << (stat.regression.ok ? "true" : "false")
            << ",\"linearRegressionError\":" << q(stat.regression.ok ? "" : stat.regression.error)
            << ",\"theoreticalBid\":" << json_number(stat.bid, 4)
            << ",\"theoreticalAsk\":" << json_number(stat.ask, 4)
            << ",\"signal\":" << q(spread_signal(stat.day_z))
            << ",\"volume\":0"
            << ",\"live\":" << (stat.live ? "true" : "false");
        if (include_bars) {
            out << ",\"bars\":[";
            for (std::size_t i = 0; i < stat.bars.size(); ++i) {
                if (i) out << ",";
                const auto& bar = stat.bars[i];
                out << "{\"timestamp\":" << bar.timestamp
                    << ",\"open\":" << json_number(bar.open, 4)
                    << ",\"high\":" << json_number(bar.high, 4)
                    << ",\"low\":" << json_number(bar.low, 4)
                    << ",\"close\":" << json_number(bar.close, 4)
                    << ",\"volume\":" << json_number(bar.volume, 2)
                    << "}";
            }
            out << "]";
        }
        out << "}";
        return out.str();
    }

    std::string advisory_spread_configs_json() const {
        std::ostringstream out;
        out << "[";
        const auto defs = spread_definitions();
        for (std::size_t i = 0; i < defs.size(); ++i) {
            const auto& spread = defs[i];
            const auto product = product_def_for(spread.symbol);
            if (i) out << ",";
            out << "{\"symbol\":" << q(spread.symbol)
                << ",\"label\":" << q(spread_label(spread.symbol))
                << ",\"meaning\":" << q(spread_expression(spread.symbol))
                << ",\"legA\":" << q(spread.left)
                << ",\"legB\":" << q(spread.right)
                << ",\"ttRatio\":" << q(spread.symbol == "ES_NQ" ? "3 ES : 2 NQ" : spread.symbol == "YM_ES" ? "10 YM : 1 ES" : "7 RTY : 3 ES")
                << ",\"displayFormula\":" << q(spread.left + " - " + json_number(spread.coef, 7) + " * " + spread.right)
                << ",\"syntheticTickValue\":" << json_number(product.tick_value, 2)
                << ",\"leftMultiplier\":" << (spread.symbol == "ES_NQ" ? 3 : spread.symbol == "YM_ES" ? 10 : 7)
                << ",\"rightMultiplier\":" << (spread.symbol == "ES_NQ" ? 2 : spread.symbol == "YM_ES" ? 1 : 3)
                << ",\"ratio\":" << json_number(spread.coef, 7)
                << "}";
        }
        out << "]";
        return out.str();
    }

    CeriousAdvisorySnapshot build_cerious_advisory_snapshot(bool allow_history_fetch = true) const {
        CeriousAdvisorySnapshot snapshot;
        snapshot.fetched_at_ms = now_ms();
        const auto fetched_at = utc_iso(std::chrono::system_clock::now()) + "Z";
        const auto cadence_ms = advisory_refresh_ms();
        const auto stats = build_advisory_spread_stats(allow_history_fetch);
        snapshot.ready = std::any_of(stats.begin(), stats.end(), [](const auto& row) {
            return !row.bars.empty() && finite(row.last) && finite(row.mean20);
        });
        AdvisorySpreadStat fallback_strongest;
        fallback_strongest.key = "ES_NQ";
        fallback_strongest.label = "ES/NQ";
        fallback_strongest.score = 50;
        fallback_strongest.regression.ok = false;
        const auto strongest = stats.empty() ? fallback_strongest : stats.front();
        const auto avg_score = stats.empty()
            ? 50.0
            : std::accumulate(stats.begin(), stats.end(), 0.0, [](double sum, const auto& row) { return sum + row.score; }) / stats.size();
        const auto avg_z = stats.empty()
            ? 0.0
            : std::accumulate(stats.begin(), stats.end(), 0.0, [](double sum, const auto& row) { return sum + row.z; }) / stats.size();
        const auto regime_strength = std::clamp(static_cast<int>(std::llround(avg_score)), 0, 100);
        const auto regime_label = regime_strength >= 60 ? "Selective Risk-On" : regime_strength <= 40 ? "Risk-Off" : "Mixed";
        const auto algo = regime_strength >= 55 ? "Mean reversion with confirmation" : "Reduce size until spread and macro confirm";
        const auto goose_direction = strongest.z <= -0.75 ? "Long " + strongest.label : strongest.z >= 0.75 ? "Short " + strongest.label : "Selective";
        const auto goose_risk = std::abs(strongest.z) >= 1.5 ? "High" : std::abs(strongest.z) >= 0.75 ? "Medium" : "Low";
        const auto goose_confidence = strongest.live && strongest.regression.ok ? "Medium" : "Low";

        std::ostringstream eligible;
        eligible << "[";
        for (std::size_t i = 0; i < stats.size(); ++i) {
            if (i) eligible << ",";
            const auto& row = stats[i];
            eligible << "{\"key\":" << q(row.key)
                << ",\"label\":" << q(row.label)
                << ",\"score\":" << row.score
                << ",\"z\":" << json_number(row.z, 4)
                << ",\"bias\":" << q(row.z <= -0.5 ? "Buy weakness when GOOSE agrees" : row.z >= 0.5 ? "Sell strength when GOOSE agrees" : "Neutral; wait for extension")
                << ",\"approach\":" << q(std::abs(row.z) >= 1.5
                    ? "Qualified extension: deploy only with macro and order-flow confirmation."
                    : "Watch list: wait for a cleaner band location before full-size deployment.")
                << "}";
        }
        eligible << "]";

        std::ostringstream daily;
        daily << "{\"service\":\"cerious.daily.summary\""
            << ",\"fetchedAt\":" << q(fetched_at)
            << ",\"subscriptionModel\":{\"owner\":\"cerious-gateway-cpp\",\"cadence\":\"daily baseline plus completed 30m advisory refresh\",\"cadenceMs\":" << cadence_ms << ",\"sources\":[\"/api/bars\",\"/api/studies/regression\",\"live top-of-book/last-trade overlay\"],\"uiPolicy\":\"render endpoint payload only\"}"
            << ",\"summaryRead\":" << q(std::string("Native Cerious daily cockpit: suggested focus is ") + strongest.label + ". Use this as the operator read before opening GOOSE, relative value visuals, and macro regime. Advisory payloads refresh on the completed 30-minute cadence while live market data continues independently.")
            << ",\"top\":["
            << "{\"label\":\"Suggested Focus\",\"value\":" << q(strongest.label) << ",\"note\":" << q(spread_signal(strongest.day_z)) << "},"
            << "{\"label\":\"Trade Bias\",\"value\":" << q(regime_label) << ",\"note\":\"Favor only the spreads where z-location, macro regime, and order-flow status agree.\"},"
            << "{\"label\":\"Macro / News\",\"value\":" << q(goose_risk) << ",\"note\":\"GOOSE and streaming headlines remain confirmation layers before full-size layering.\"},"
            << "{\"label\":\"Data Quality\",\"value\":" << q(strongest.live ? "Live" : "Backfill") << ",\"note\":\"Endpoint is generated by the native C++ advisory model, not a copied dashboard file.\"}"
            << "],\"classification\":["
            << "{\"label\":\"Current Bias\",\"value\":" << q(regime_label) << ",\"note\":\"Derived from spread scores, z-location, live state, and macro factor pressure.\"},"
            << "{\"label\":\"Eligible Spreads\",\"value\":" << q(stats.empty() ? "Waiting" : spread_label(stats.front().key)) << ",\"note\":\"Ranked by the server-side relative value model.\"},"
            << "{\"label\":\"Algorithmic Approach\",\"value\":\"Mean Reversion First\",\"note\":\"Layer only from qualified bands; reduce size when ATR and macro pressure expand.\"},"
            << "{\"label\":\"Risk-On / Off Strength\",\"value\":" << q(std::to_string(regime_strength) + "/100") << ",\"note\":\"Formula scale is served by the advisory endpoint and rendered by the widget.\"}"
            << "],\"sourcePills\":["
            << "{\"label\":\"Server Endpoint\",\"tone\":\"blue\"},"
            << "{\"label\":\"Completed 30m Cadence\",\"tone\":\"blue\"},"
            << "{\"label\":\"Daily Baseline\",\"tone\":\"amber\"},"
            << "{\"label\":\"Live Overlay\",\"tone\":\"amber\"}"
            << "],\"eligibleSpreads\":" << eligible.str()
            << ",\"gooseComplement\":" << q("Daily Summary and GOOSE now consume the same native advisory snapshot. Daily Summary is the cockpit; GOOSE is the active confirmation read.")
            << "}";
        snapshot.daily_summary = daily.str();

        std::ostringstream macro;
        macro << "{\"service\":\"macro.regime\",\"fetchedAt\":" << q(fetched_at)
            << ",\"subscriptionModel\":{\"owner\":\"cerious-gateway-cpp\",\"cadence\":\"completed 30m advisory refresh\",\"cadenceMs\":" << cadence_ms << ",\"sources\":[\"spread relative-value bars\",\"live market overlay\"],\"uiPolicy\":\"render endpoint payload only\"}"
            << ",\"label\":" << q(regime_label)
            << ",\"strength\":" << regime_strength
            << ",\"algo\":" << q(algo)
            << ",\"score\":" << regime_strength
            << ",\"factors\":{\"volatility\":" << json_number((100.0 - avg_score) / 100.0, 4)
            << ",\"rates\":" << json_number(avg_z / 3.0, 4)
            << ",\"credit\":" << json_number((strongest.key == "RTY_ES" ? strongest.z : avg_z) / 3.0, 4)
            << ",\"breadth\":" << json_number(avg_score / 100.0, 4)
            << ",\"smallCapLeadership\":" << json_number((strongest.key == "RTY_ES" ? -strongest.z : 0.0), 4)
            << ",\"news\":0}"
            << ",\"factorRows\":["
            << "{\"key\":\"Volatility\",\"value\":" << json_number((100.0 - avg_score) / 100.0, 4) << ",\"weight\":0.2,\"contribution\":" << json_number((100.0 - avg_score) * 0.2, 2) << "},"
            << "{\"key\":\"Rates\",\"value\":" << json_number(avg_z / 3.0, 4) << ",\"weight\":0.2,\"contribution\":" << json_number(avg_z * 6.7, 2) << "},"
            << "{\"key\":\"Credit\",\"value\":" << json_number((strongest.key == "RTY_ES" ? strongest.z : avg_z) / 3.0, 4) << ",\"weight\":0.18,\"contribution\":" << json_number((strongest.key == "RTY_ES" ? strongest.z : avg_z) * 6.0, 2) << "},"
            << "{\"key\":\"Breadth\",\"value\":" << json_number((avg_score - 50.0) / 50.0, 4) << ",\"weight\":0.18,\"contribution\":" << json_number((avg_score - 50.0) * 0.18, 2) << "},"
            << "{\"key\":\"SmallCap Leadership\",\"value\":" << json_number((strongest.key == "RTY_ES" ? -strongest.z : 0.0) / 2.0, 4) << ",\"weight\":0.14,\"contribution\":" << json_number((strongest.key == "RTY_ES" ? -strongest.z : 0.0) * 7.0, 2) << "},"
            << "{\"key\":\"Headlines\",\"value\":0,\"weight\":0.1,\"contribution\":0}"
            << "],\"newsRead\":{\"bias\":\"mixed\",\"score\":52,\"urgentCount\":0,\"summary\":\"Streaming news is handled separately; no urgent headline override applied to this advisory snapshot.\"}"
            << ",\"leadership\":{\"ES\":" << json_number(avg_z, 4) << ",\"NQ\":" << json_number(-avg_z, 4) << ",\"YM\":" << json_number(avg_z / 2.0, 4) << ",\"RTY\":" << json_number(strongest.key == "RTY_ES" ? -strongest.z : 0.0, 4) << "}"
            << ",\"rtyVolumeShare\":0.19"
            << ",\"read\":" << q("Macro regime is " + std::string(regime_label) + ". Let GOOSE confirm before full-size deployment; advisory numbers refresh on the low-frequency spread cadence while live LTP updates separately.")
            << "}";
        snapshot.macro_regime = macro.str();

        std::ostringstream rows;
        rows << "[";
        for (std::size_t i = 0; i < stats.size(); ++i) {
            if (i) rows << ",";
            const auto& row = stats[i];
            rows << "{\"key\":" << q(row.key)
                << ",\"label\":" << q(row.label)
                << ",\"score\":" << row.score
                << ",\"z\":" << json_number(row.z, 4)
                << ",\"spread\":" << json_number(row.last, 4)
                << ",\"signal\":" << q(spread_signal(row.day_z))
                << ",\"expression\":" << q(spread_expression(row.key))
                << ",\"risk\":" << q(spread_risk_read(row.key))
                << ",\"location\":" << std::clamp(static_cast<int>(std::llround(50.0 + row.z * 20.0)), 0, 100)
                << ",\"confirmation\":" << row.order_flow_score
                << ",\"regime\":" << regime_strength
                << ",\"liquidity\":" << (row.live ? 82 : 35)
                << "}";
        }
        rows << "]";

        std::ostringstream opportunity;
        opportunity << "{\"service\":\"signal.cross-spread\",\"fetchedAt\":" << q(fetched_at)
            << ",\"subscriptionModel\":{\"owner\":\"cerious-gateway-cpp\",\"cadence\":\"completed 30m advisory refresh\",\"cadenceMs\":" << cadence_ms << ",\"sources\":[\"spread bars\",\"macro regime\",\"live market overlay\"],\"uiPolicy\":\"render endpoint payload only\"}"
            << ",\"rows\":" << rows.str()
            << ",\"playbookRows\":["
            << "{\"signalCombination\":\"RTY/ES up + ES/NQ up\",\"interpretation\":\"Small caps outperform while Nasdaq underperforms. Broadening or domestic cyclicals.\",\"expression\":\"Long RTY / short NQ\",\"risk\":\"Watch rates and credit. This can reverse violently on hawkish shocks.\"},"
            << "{\"signalCombination\":\"RTY/ES down + ES/NQ down\",\"interpretation\":\"Small caps lag while Nasdaq leads. Narrow mega-cap growth regime.\",\"expression\":\"Long NQ / short RTY\",\"risk\":\"Momentum can persist. Avoid premature fades.\"},"
            << "{\"signalCombination\":\"YM/ES up + RTY/ES up\",\"interpretation\":\"Value, cyclicals, and small caps all improving.\",\"expression\":\"Long YM and RTY basket / short ES\",\"risk\":\"Confirm with market breadth and regional banks.\"},"
            << "{\"signalCombination\":\"YM/ES up + RTY/ES down\",\"interpretation\":\"Dow/value outperforms, but small-cap credit beta remains suspect.\",\"expression\":\"Long YM / short RTY\",\"risk\":\"Often defensive value, not true risk-on.\"},"
            << "{\"signalCombination\":\"ES/NQ down + YM/ES down\",\"interpretation\":\"Nasdaq and S&P growth leadership over Dow value.\",\"expression\":\"Long NQ / short YM\",\"risk\":\"Size carefully around earnings concentration in mega-cap tech.\"}"
            << "],\"productRows\":[";
        const auto defs = spread_definitions();
        for (std::size_t i = 0; i < defs.size(); ++i) {
            if (i) opportunity << ",";
            const auto& def = defs[i];
            opportunity << "{\"spread\":" << q(spread_label(def.symbol))
                << ",\"label\":" << q(def.symbol == "ES_NQ" ? "S&P versus Nasdaq" : def.symbol == "RTY_ES" ? "Russell versus S&P" : "Dow versus S&P")
                << ",\"tag\":" << q(def.symbol == "ES_NQ" ? "Growth leadership" : def.symbol == "RTY_ES" ? "Small-cap beta" : "Value/cyclical leadership")
                << ",\"formula\":" << q(def.left + " - " + json_number(def.coef, 7) + " * " + def.right)
                << ",\"buy\":" << q("Buy " + def.left + " / sell " + def.right)
                << ",\"sell\":" << q("Sell " + def.left + " / buy " + def.right)
                << ",\"nuance\":" << q(spread_risk_read(def.symbol))
                << "}";
        }
        opportunity << "],\"tradePlanRows\":["
            << "{\"title\":\"Entry\",\"body\":\"Enter at +/-1.5 ATR only when macro regime, GOOSE direction, and live spread signal agree.\"},"
            << "{\"title\":\"Layering\",\"body\":\"Use staged clips only after the signal is confirmed by the current spread snapshot.\"},"
            << "{\"title\":\"Exit\",\"body\":\"Take risk down near the rolling mean and keep final scale-out disciplined.\"}"
            << "],\"riskChecklistRows\":["
            << "{\"risk\":\"Tail beta mismatch\",\"control\":\"Measure dollar delta by leg and rebalance when index levels move materially.\"},"
            << "{\"risk\":\"Hidden ES exposure\",\"control\":\"When combining spreads, net all ES legs before sizing.\"},"
            << "{\"risk\":\"Volatility regime shift\",\"control\":\"Use ATR percentile to reduce size above the 80th percentile.\"},"
            << "{\"risk\":\"Macro invalidation\",\"control\":\"Stop buying small-cap weakness if rates and credit both deteriorate.\"},"
            << "{\"risk\":\"Execution slippage\",\"control\":\"Use legging settings conservatively around data releases and cash open.\"}"
            << "]}";
        snapshot.opportunity_map = opportunity.str();

        std::ostringstream spread_array;
        spread_array << "[";
        for (std::size_t i = 0; i < stats.size(); ++i) {
            if (i) spread_array << ",";
            spread_array << advisory_spread_json(stats[i], true);
        }
        spread_array << "]";

        std::ostringstream signal_array;
        signal_array << "[";
        for (std::size_t i = 0; i < stats.size(); ++i) {
            if (i) signal_array << ",";
            signal_array << advisory_spread_json(stats[i], false);
        }
        signal_array << "]";

        std::ostringstream intelligence;
        intelligence << "{\"goose\":{\"strategy\":\"Mean Reversion\""
            << ",\"direction\":" << q(goose_direction)
            << ",\"risk\":" << q(goose_risk)
            << ",\"confidence\":" << q(goose_confidence)
            << ",\"read\":" << q("GOOSE confirms " + strongest.label + " as the current highest-scoring spread. Use relative-value mean reversion only when macro regime, spread location, and live signal agree.")
            << ",\"evidence\":["
            << "[\"Cadence\",\"GOOSE remains a low-frequency advisor, not a tick-by-tick trigger.\"],"
            << "[\"Primary Gate\",\"Macro/news context plus spread z-score confirmation.\"],"
            << "[\"Risk Gate\",\"ATR expansion cuts size and widens bands.\"],"
            << "[\"Execution\",\"Layer passively first; add only on extension plus stabilization.\"]"
            << "],\"updateCadence\":\"Completed 30m advisory review with significant-change threshold; live market data publishes separately\""
            << ",\"updatedAt\":" << q(fetched_at)
            << ",\"nextReviewSeconds\":" << (cadence_ms / 1000ULL) << "}"
            << ",\"subscriptionModel\":{\"owner\":\"cerious-gateway-cpp\",\"cadence\":\"completed 30m advisory refresh\",\"cadenceMs\":" << cadence_ms << ",\"sources\":[\"/api/bars\",\"/api/studies/regression\",\"live top-of-book/last-trade overlay\"],\"uiPolicy\":\"render endpoint payload only\"}"
            << ",\"macroRegime\":" << snapshot.macro_regime
            << ",\"spreadConfigs\":" << advisory_spread_configs_json()
            << ",\"spreadPack\":{\"updatedAt\":" << q(fetched_at)
            << ",\"cadence\":\"Daily baseline plus completed 30m study bars; live LTP overlays update from market data\""
            << ",\"strongest\":" << (stats.empty() ? "{}" : advisory_spread_json(strongest, true))
            << ",\"spreads\":" << spread_array.str()
            << "}"
            << ",\"liveSpreadSignals\":" << signal_array.str()
            << "}";
        snapshot.intelligence = intelligence.str();
        return snapshot;
    }

    CeriousAdvisorySnapshot static_cerious_advisory_snapshot() const {
        CeriousAdvisorySnapshot snapshot;
        snapshot.fetched_at_ms = 0;
        snapshot.ready = true;
        const auto root = data / "window-payloads" / "cerious";
        snapshot.intelligence = read_text(root / "intelligence.json").value_or(
            "{\"subscriptionModel\":{\"owner\":\"cerious-gateway-cpp\",\"cadence\":\"completed 30m advisory refresh\",\"cadenceMs\":1800000,\"sources\":[\"/api/bars\",\"/api/studies/regression\",\"live top-of-book/last-trade overlay\"],\"uiPolicy\":\"render endpoint payload only\"},\"goose\":{\"strategy\":\"Mean Reversion\",\"direction\":\"Waiting\",\"risk\":\"Medium\",\"confidence\":\"Low\",\"read\":\"Waiting for advisory refresh.\",\"evidence\":[],\"updateCadence\":\"Completed 30m advisory review\"},\"spreadPack\":{\"spreads\":[]},\"liveSpreadSignals\":[],\"macroRegime\":{\"label\":\"Waiting\",\"strength\":50,\"algo\":\"Waiting\",\"factorRows\":[]}}"
        );
        snapshot.daily_summary = read_text(root / "daily-summary.json").value_or(
            "{\"service\":\"cerious.daily.summary\",\"summaryRead\":\"Waiting for native advisory refresh.\",\"top\":[],\"classification\":[],\"sourcePills\":[],\"eligibleSpreads\":[],\"subscriptionModel\":{\"owner\":\"cerious-gateway-cpp\",\"cadence\":\"completed 30m advisory refresh\",\"cadenceMs\":1800000}}"
        );
        snapshot.macro_regime = read_text(root / "macro-regime.json").value_or(
            "{\"service\":\"macro.regime\",\"subscriptionModel\":{\"owner\":\"cerious-gateway-cpp\",\"cadence\":\"completed 30m advisory refresh\",\"cadenceMs\":1800000},\"label\":\"Waiting\",\"strength\":50,\"algo\":\"Waiting\",\"factorRows\":[],\"read\":\"Waiting for advisory refresh.\"}"
        );
        snapshot.opportunity_map = read_text(root / "opportunity-map.json").value_or(
            "{\"service\":\"signal.cross-spread\",\"subscriptionModel\":{\"owner\":\"cerious-gateway-cpp\",\"cadence\":\"completed 30m advisory refresh\",\"cadenceMs\":1800000},\"rows\":[],\"playbookRows\":[],\"productRows\":[],\"riskChecklistRows\":[]}"
        );
        return snapshot;
    }

    void start_cerious_advisory_refresh() const {
        {
            std::lock_guard<std::mutex> lock(cerious_advisory_mutex);
            if (cerious_advisory_refreshing) return;
            cerious_advisory_refreshing = true;
        }
        std::thread([this]() {
            try {
                auto next = build_cerious_advisory_snapshot(true);
                std::lock_guard<std::mutex> lock(cerious_advisory_mutex);
                if (next.ready) {
                    cerious_advisory_cache = std::move(next);
                }
                cerious_advisory_refreshing = false;
            } catch (const std::exception& ex) {
                std::cerr << "cerious advisory refresh failed: " << ex.what() << std::endl;
                std::lock_guard<std::mutex> lock(cerious_advisory_mutex);
                cerious_advisory_refreshing = false;
            } catch (...) {
                std::cerr << "cerious advisory refresh failed with unknown error" << std::endl;
                std::lock_guard<std::mutex> lock(cerious_advisory_mutex);
                cerious_advisory_refreshing = false;
            }
        }).detach();
    }

    CeriousAdvisorySnapshot cerious_advisory_snapshot(bool blocking_refresh = false) const {
        const auto current = now_ms();
        const auto cadence_ms = advisory_refresh_ms();
        {
            std::lock_guard<std::mutex> lock(cerious_advisory_mutex);
            if (cerious_advisory_cache && current >= cerious_advisory_cache->fetched_at_ms
                && cerious_advisory_cache->ready
                && current - cerious_advisory_cache->fetched_at_ms < cadence_ms) {
                return *cerious_advisory_cache;
            }
            if (cerious_advisory_cache && !blocking_refresh) {
                const auto stale = *cerious_advisory_cache;
                if (!cerious_advisory_refreshing) {
                    // Refresh outside this lock; callers keep the last known good payload.
                } else {
                    return stale;
                }
            }
        }

        if (!blocking_refresh) {
            std::optional<CeriousAdvisorySnapshot> stale;
            {
                std::lock_guard<std::mutex> lock(cerious_advisory_mutex);
                if (cerious_advisory_cache) stale = *cerious_advisory_cache;
            }
            if (!stale) {
                auto next = static_cerious_advisory_snapshot();
                {
                    std::lock_guard<std::mutex> lock(cerious_advisory_mutex);
                    cerious_advisory_cache = next;
                    cerious_advisory_refreshing = false;
                }
                start_cerious_advisory_refresh();
                return next;
            }
            start_cerious_advisory_refresh();
            return *stale;
        }

        auto next = build_cerious_advisory_snapshot();
        {
            std::lock_guard<std::mutex> lock(cerious_advisory_mutex);
            cerious_advisory_cache = next;
            cerious_advisory_refreshing = false;
        }
        return next;
    }

    std::string cerious_intelligence_json() const {
        return cerious_advisory_snapshot(false).intelligence;
    }

    std::string cerious_daily_summary_json() const {
        return cerious_advisory_snapshot(false).daily_summary;
    }

    std::string cerious_macro_regime_json() const {
        return cerious_advisory_snapshot(false).macro_regime;
    }

    std::string cerious_opportunity_map_json() const {
        return cerious_advisory_snapshot(false).opportunity_map;
    }

    std::string cerious_subscription_model_json() const {
        const auto cadence_ms = advisory_refresh_ms();
        return "{\"ok\":true,\"runtime\":\"cpp\",\"owner\":\"cerious-gateway-cpp\",\"model\":\"server-owned advisory subscriptions\",\"rules\":["
            "{\"widget\":\"Daily Summary\",\"endpoint\":\"/api/cerious/daily-summary\",\"cadenceMs\":" + std::to_string(cadence_ms) + ",\"sources\":[\"daily bars\",\"weekly context\",\"completed 30m advisory snapshot\",\"live overlay\"]},"
            "{\"widget\":\"GOOSE\",\"endpoint\":\"/api/cerious/intelligence\",\"cadenceMs\":" + std::to_string(cadence_ms) + ",\"sources\":[\"relative value spread pack\",\"macro regime\",\"daily/weekly context\",\"live overlay\"]},"
            "{\"widget\":\"Live Spread Signals\",\"endpoint\":\"/api/cerious/intelligence\",\"payload\":\"liveSpreadSignals\",\"cadenceMs\":" + std::to_string(cadence_ms) + ",\"sources\":[\"completed 30m study bars\",\"server regression study\",\"live last-trade overlay\"]},"
            "{\"widget\":\"Relative Spread Visuals\",\"endpoint\":\"/api/cerious/intelligence\",\"payload\":\"spreadPack.spreads\",\"cadenceMs\":" + std::to_string(cadence_ms) + ",\"sources\":[\"daily baseline\",\"weekly context\",\"completed 30m study bars\",\"live overlay\"]},"
            "{\"widget\":\"Relative Spread Charts\",\"endpoint\":\"/api/cerious/intelligence\",\"payload\":\"spreadPack.spreads[].bars\",\"cadenceMs\":" + std::to_string(cadence_ms) + ",\"sources\":[\"server historical bars\",\"advisory chart bars\",\"live overlay marker\"]},"
            "{\"widget\":\"Macro Regime Summary\",\"endpoint\":\"/api/cerious/macro-regime\",\"cadenceMs\":" + std::to_string(cadence_ms) + ",\"sources\":[\"relative value scores\",\"macro factor model\",\"weekly context\"]},"
            "{\"widget\":\"Cross-Spread Opportunity Map\",\"endpoint\":\"/api/cerious/opportunity-map\",\"cadenceMs\":" + std::to_string(cadence_ms) + ",\"sources\":[\"spread rankings\",\"macro regime\",\"liquidity/live state\"]}"
            "]}";
    }

    httplib::Result execution_get(const std::string& path) const {
        httplib::Client client(args.execution_host, args.execution_port);
        client.set_connection_timeout(2, 0);
        client.set_read_timeout(4, 0);
        return client.Get(path);
    }

    httplib::Result execution_post(const std::string& path, const std::string& body) const {
        httplib::Client client(args.execution_host, args.execution_port);
        client.set_connection_timeout(2, 0);
        client.set_read_timeout(5, 0);
        return client.Post(path, body, "application/json");
    }

    std::string execution_state_json() const {
        auto state = execution_get("/state");
        if (state && state->status >= 200 && state->status < 300) return state->body;
        return "{\"service\":\"cerious.exchange\",\"simOrders\":[],\"simPositions\":[],\"fills\":{},\"simMessages\":[\"CERIOUS EXCHANGE STATE UNAVAILABLE\"]}";
    }

    std::string order_id_from_payload(const std::string& body) const {
        auto order_id = trim_copy(get_string(body, "orderId", ""));
        if (order_id.empty()) order_id = trim_copy(get_string(body, "id", ""));
        if (order_id.empty()) order_id = trim_copy(get_string(body, "clientOrderId", ""));
        if (order_id.empty()) order_id = trim_copy(get_string(body, "order_id", ""));
        return order_id;
    }

    std::string payload_with_order_id(const std::string& body, const std::string& order_id) const {
        if (!trim_copy(get_string(body, "orderId", "")).empty()) return body;
        const auto open = body.find('{');
        if (open == std::string::npos) {
            return "{\"orderId\":" + q(order_id) + "}";
        }
        return body.substr(0, open + 1) + "\"orderId\":" + q(order_id) + "," + body.substr(open + 1);
    }

    std::string wrap_execution_event(const std::string& event_json) const {
        return "{\"ok\":true,\"runtime\":\"cpp\",\"event\":" + event_json
            + ",\"state\":" + execution_state_json() + "}";
    }

    std::string wrap_state_payload(const std::string& state) const {
        return "{\"ok\":true,\"service\":\"cerious.exchange\",\"state\":" + state
            + ",\"simOrders\":[],\"simPositions\":[],\"fills\":{},\"simMessages\":[]}";
    }

    static double round_to_tick(double price, double tick_size) {
        if (!finite(price) || !finite(tick_size) || tick_size <= 0.0) return price;
        return std::round(price / tick_size) * tick_size;
    }

    static std::vector<std::string> json_objects_with_key(const std::string& json, const std::string& key) {
        std::vector<std::string> objects;
        const auto needle = "\"" + key + "\"";
        std::size_t pos = 0;
        while ((pos = json.find(needle, pos)) != std::string::npos) {
            const auto start = json.rfind('{', pos);
            if (start == std::string::npos) {
                pos += needle.size();
                continue;
            }
            int depth = 0;
            bool in_string = false;
            bool escaped = false;
            for (std::size_t i = start; i < json.size(); ++i) {
                const char ch = json[i];
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (ch == '\\' && in_string) {
                    escaped = true;
                    continue;
                }
                if (ch == '"') {
                    in_string = !in_string;
                    continue;
                }
                if (in_string) continue;
                if (ch == '{') ++depth;
                else if (ch == '}') {
                    --depth;
                    if (depth == 0) {
                        objects.push_back(json.substr(start, i - start + 1));
                        pos = i + 1;
                        break;
                    }
                }
            }
            if (pos <= start) pos = start + 1;
        }
        return objects;
    }

    void remember_algo_cover_policy(const std::string& order_json) const {
        const auto order_id = get_string(order_json, "orderId", "");
        if (order_id.empty()) return;
        if (get_string(order_json, "source", "") != "algo") return;
        if (get_string(order_json, "algoRole", "") != "entry") return;
        const auto cover_ticks = get_number(order_json, "coverTicksFromFill").value_or(0.0);
        const auto tick_size = get_number(order_json, "coverTickSize").value_or(0.0);
        if (!finite(cover_ticks) || cover_ticks <= 0.0 || !finite(tick_size) || tick_size <= 0.0) return;

        AlgoCoverPolicy policy;
        policy.symbol = canonical_market_symbol(get_string(order_json, "marketKey", get_string(order_json, "symbol", "")));
        policy.strategy = get_string(order_json, "strategy", "");
        policy.algo_id = get_string(order_json, "algoId", "");
        policy.algo_name = get_string(order_json, "algoName", "");
        policy.layer = static_cast<int>(std::llround(get_number(order_json, "layer").value_or(0.0)));
        policy.cover_ticks = cover_ticks;
        policy.tick_size = tick_size;

        std::lock_guard<std::mutex> lock(algo_cover_mutex);
        algo_cover_policies[order_id] = std::move(policy);
    }

    void process_exchange_fill_events(const std::string& state_or_response_json) const {
        std::vector<std::string> cover_orders;
        for (const auto& fill : json_objects_with_key(state_or_response_json, "orderId")) {
            const auto order_id = get_string(fill, "orderId", "");
            if (order_id.empty()) continue;
            const auto event_key = order_id + "|" + get_string(fill, "timestamp", "0") + "|"
                + get_string(fill, "price", "0") + "|" + get_string(fill, "size", "0");

            AlgoCoverPolicy policy;
            {
                std::lock_guard<std::mutex> lock(algo_cover_mutex);
                if (!processed_sim_fill_events.insert(event_key).second) continue;
                const auto policy_it = algo_cover_policies.find(order_id);
                if (policy_it == algo_cover_policies.end()) continue;
                policy = policy_it->second;
            }

            const auto role = get_string(fill, "algoRole", "");
            const auto source = get_string(fill, "source", "");
            if (source != "algo" || role != "entry") continue;
            const auto symbol = canonical_market_symbol(get_string(fill, "marketKey", get_string(fill, "symbol", policy.symbol)));
            const auto fill_price = get_number(fill, "price").value_or(get_number(fill, "executionPrice").value_or(std::nan("")));
            const auto raw_qty = get_number(fill, "size").value_or(get_number(fill, "qty").value_or(get_number(fill, "fillQuantity").value_or(1.0)));
            const auto fill_qty = std::max(1, static_cast<int>(std::llround(raw_qty)));
            if (!finite(fill_price) || fill_qty <= 0) continue;

            const auto display_side = upper_ascii(get_string(fill, "displaySide", ""));
            const auto raw_side = lower_ascii(get_string(fill, "side", ""));
            const bool entry_buy = display_side == "BUY" || raw_side == "yes" || raw_side == "bid" || raw_side == "buy";
            const auto cover_side = entry_buy ? std::string("offer") : std::string("bid");
            const auto raw_cover_price = entry_buy
                ? fill_price + (policy.cover_ticks * policy.tick_size)
                : fill_price - (policy.cover_ticks * policy.tick_size);
            const auto cover_price = round_to_tick(raw_cover_price, policy.tick_size);
            const auto cover_id = order_id + "-COVER-" + get_string(fill, "timestamp", std::to_string(now_ms()));

            std::ostringstream out;
            out << "{\"orderId\":" << q(cover_id)
                << ",\"clientOrderId\":" << q(cover_id)
                << ",\"provider\":\"cme\""
                << ",\"marketKey\":" << q(symbol)
                << ",\"symbol\":" << q(symbol)
                << ",\"side\":" << q(cover_side)
                << ",\"orderType\":\"limit\""
                << ",\"price\":" << json_number(cover_price)
                << ",\"size\":" << fill_qty
                << ",\"source\":\"algo\""
                << ",\"strategy\":" << q(policy.strategy.empty() ? "algo-cover" : policy.strategy)
                << ",\"algoId\":" << q(policy.algo_id)
                << ",\"algoName\":" << q(policy.algo_name)
                << ",\"algoRole\":\"cover\""
                << ",\"orderTag\":\"ALGO COVER\""
                << ",\"parentOrderId\":" << q(order_id)
                << ",\"layer\":" << policy.layer
                << ",\"trigger\":" << q("cover from fill " + order_id)
                << "}";
            cover_orders.push_back(out.str());
        }

        for (const auto& cover_order : cover_orders) {
            auto result = execution_post("/send", cover_order);
            if (!result || result->status < 200 || result->status >= 300) {
                append_algo_audit("COVER ERROR failed to send cover order: " + (result ? result->body : std::string("cerious exchange unavailable")));
            }
        }
    }

    static std::string json_number(double value, int precision = 9) {
        if (!finite(value)) return "null";
        std::ostringstream out;
        out << std::fixed << std::setprecision(precision) << value;
        auto text = out.str();
        while (text.size() > 1 && text.back() == '0') text.pop_back();
        if (!text.empty() && text.back() == '.') text.pop_back();
        return text.empty() ? "0" : text;
    }

    void append_algo_audit(const std::string& message) const {
        const auto dir = data / "logs";
        std::error_code ec;
        fs::create_directories(dir, ec);
        std::ofstream out(dir / "algo-audit.log", std::ios::app | std::ios::binary);
        if (!out) return;
        out << utc_iso(std::chrono::system_clock::now()) << "Z " << message << "\n";
    }

    std::optional<std::string> algo_definition_for_id(const std::string& id) const {
        const auto clean_id = trim_copy(id);
        if (clean_id.empty()) return std::nullopt;
        const auto dir = data / "algo-definitions";
        std::error_code ec;
        if (!fs::exists(dir, ec)) return std::nullopt;

        std::optional<std::string> best;
        std::uint64_t best_updated_at = 0;
        for (const auto& entry : fs::directory_iterator(dir, ec)) {
            if (ec) break;
            if (!entry.is_regular_file()) continue;
            const auto path = entry.path();
            if (path.extension() != ".json") continue;
            if (path.filename().string().starts_with("_")) continue;
            auto content = read_text(path);
            if (!content || is_deleted_definition(*content)) continue;
            if (get_string(*content, "id", "") != clean_id) continue;
            const auto updated_at = get_u64_number(*content, "updatedAt", 0);
            if (!best || updated_at >= best_updated_at) {
                best = *content;
                best_updated_at = updated_at;
            }
        }
        return best;
    }

    std::string build_algo_order_json(
        const std::string& algo_id,
        const std::string& algo_name,
        const std::string& symbol,
        const std::string& side,
        double price,
        int size,
        int layer,
        int lookback,
        const std::string& band_label,
        double cover_ticks,
        double tick_size) const {
        const auto order_id = "ALGO-" + algo_id + "-" + upper_ascii(side) + "-"
            + std::to_string(layer) + "-" + std::to_string(now_ms());
        std::ostringstream out;
        out << "{\"orderId\":" << q(order_id)
            << ",\"clientOrderId\":" << q(order_id)
            << ",\"provider\":\"cme\""
            << ",\"marketKey\":" << q(symbol)
            << ",\"symbol\":" << q(symbol)
            << ",\"side\":" << q(side)
            << ",\"orderType\":\"limit\""
            << ",\"price\":" << json_number(price)
            << ",\"size\":" << std::max(1, size)
            << ",\"source\":\"algo\""
            << ",\"strategy\":" << q(algo_name)
            << ",\"algoId\":" << q(algo_id)
            << ",\"algoName\":" << q(algo_name)
            << ",\"algoRole\":\"entry\""
            << ",\"orderTag\":\"ALGO ENTRY\""
            << ",\"layer\":" << layer
            << ",\"trigger\":" << q("Linear Regression lookback " + std::to_string(lookback) + " " + band_label)
            << ",\"coverTicksFromFill\":" << json_number(cover_ticks)
            << ",\"coverTickSize\":" << json_number(tick_size)
            << "}";
        return out.str();
    }

    std::string deploy_algo_definitions_json(const std::string& body, int& status) const {
        status = 200;
        const auto algo_ids = get_string_array(body, "algoIds");
        const bool dry_run = get_bool(body, "dryRun", false);
        std::vector<std::string> errors;
        std::vector<std::string> notes;
        std::vector<std::string> orders;

        if (algo_ids.empty()) {
            status = 400;
            return "{\"ok\":false,\"detail\":\"deploy request contains no algo ids\",\"errors\":[\"No algo definitions selected\"],\"state\":"
                + execution_state_json() + "}";
        }

        for (const auto& algo_id : algo_ids) {
            const auto definition = algo_definition_for_id(algo_id);
            if (!definition) {
                errors.push_back("algo definition not found: " + algo_id);
                continue;
            }

            const auto& def = *definition;
            const auto name = get_string(def, "name", algo_id);
            auto symbol = canonical_market_symbol(get_string(def, "marketKey", get_string(def, "symbol", "")));
            if (symbol.empty()) {
                const auto instruments = get_string_array(def, "instruments");
                if (!instruments.empty()) symbol = canonical_market_symbol(instruments.front());
            }
            if (symbol.empty()) {
                errors.push_back(name + ": product missing");
                continue;
            }

            const auto entry_peg = get_object(def, "entryPeg").value_or("{}");
            const auto layer_plan = get_object(def, "layerPlan").value_or("{}");
            const auto exit_policy = get_object(def, "exitPolicy").value_or("{}");
            const auto product = product_def_for(symbol);
            if (!finite(product.tick_size) || product.tick_size <= 0.0) {
                errors.push_back(name + ": product tick size missing for " + symbol);
                continue;
            }

            auto raw_lookback = get_number(entry_peg, "lookback");
            if (!raw_lookback || !finite(*raw_lookback) || *raw_lookback < 2.0) {
                const auto detail = name + ": regression lookback is not defined";
                errors.push_back(detail);
                append_algo_audit("DEPLOY ERROR " + detail);
                continue;
            }
            const auto lookback = std::clamp(static_cast<int>(std::llround(*raw_lookback)), 2, 2000);
            const auto standard_deviations = std::clamp(get_number(entry_peg, "standardDeviations").value_or(2.0), 0.0, 20.0);
            const auto interval = get_string(entry_peg, "interval", get_string(entry_peg, "timeframe", "30m"));
            const auto cached_study = cached_regression_study(symbol, interval, lookback, standard_deviations);
            const auto study = cached_study && cached_study->ok
                ? *cached_study
                : calculate_regression_study(symbol, interval, lookback, standard_deviations);
            if (!study.ok) {
                const auto detail = name + ": send price not published for linear-regression lookback " + std::to_string(lookback)
                    + " (" + symbol + " " + interval + ", bars " + std::to_string(study.bars)
                    + (study.error.empty() ? "" : ": " + study.error) + ")";
                errors.push_back(detail);
                append_algo_audit("DEPLOY ERROR " + detail);
                continue;
            }

            const auto side = lower_ascii(get_string(def, "side", "both"));
            const bool side_allows_bid = side == "both" || side == "bid" || side == "buy";
            const bool side_allows_offer = side == "both" || side == "offer" || side == "ask" || side == "sell";
            const bool work_bid = side_allows_bid && get_bool(layer_plan, "workBuySide", true);
            const bool work_offer = side_allows_offer && get_bool(layer_plan, "workSellSide", true);
            if (!work_bid && !work_offer) {
                errors.push_back(name + ": layer plan has no active side");
                continue;
            }

            const auto layers = std::clamp(static_cast<int>(std::llround(get_number(layer_plan, "layerCount").value_or(1.0))), 1, 100);
            const auto spacing_ticks = std::max(0.0, get_number(layer_plan, "layerSpacingTicks").value_or(0.0));
            const auto size = std::max(1, static_cast<int>(std::llround(get_number(def, "clipSize").value_or(1.0))));
            const auto cover_ticks = std::max(0.0, get_number(exit_policy, "coverTicksFromFill").value_or(0.0));

            for (int layer = 0; layer < layers; ++layer) {
                const auto offset = static_cast<double>(layer) * spacing_ticks * product.tick_size;
                if (work_bid) {
                    const auto price = round_to_tick(study.lower - offset, product.tick_size);
                    orders.push_back(build_algo_order_json(algo_id, name, symbol, "bid", price, size, layer + 1, lookback, "lower", cover_ticks, product.tick_size));
                }
                if (work_offer) {
                    const auto price = round_to_tick(study.upper + offset, product.tick_size);
                    orders.push_back(build_algo_order_json(algo_id, name, symbol, "offer", price, size, layer + 1, lookback, "upper", cover_ticks, product.tick_size));
                }
            }
            notes.push_back(name + " resolved linear-regression lookback " + std::to_string(lookback) + " " + interval
                + " lower " + json_number(study.lower, 4) + " upper " + json_number(study.upper, 4));
        }

        if (!errors.empty() && orders.empty()) {
            status = 400;
            std::ostringstream out;
            out << "{\"ok\":false,\"acceptedCount\":0,\"detail\":" << q(errors.front())
                << ",\"errors\":[";
            for (std::size_t i = 0; i < errors.size(); ++i) {
                if (i) out << ",";
                out << q(errors[i]);
            }
            out << "],\"notes\":[";
            for (std::size_t i = 0; i < notes.size(); ++i) {
                if (i) out << ",";
                out << q(notes[i]);
            }
            out << "],\"state\":" << execution_state_json() << "}";
            return out.str();
        }

        if (!errors.empty()) {
            status = 400;
            return "{\"ok\":false,\"acceptedCount\":0,\"detail\":\"one or more algo definitions are invalid; no orders sent\",\"state\":"
                + execution_state_json() + "}";
        }

        if (dry_run) {
            std::ostringstream out;
            out << "{\"ok\":true,\"dryRun\":true,\"acceptedCount\":" << orders.size()
                << ",\"orders\":[";
            for (std::size_t i = 0; i < orders.size(); ++i) {
                if (i) out << ",";
                out << orders[i];
            }
            out << "],\"notes\":[";
            for (std::size_t i = 0; i < notes.size(); ++i) {
                if (i) out << ",";
                out << q(notes[i]);
            }
            out << "],\"state\":" << execution_state_json() << "}";
            return out.str();
        }

        std::string latest_state = execution_state_json();
        for (const auto& order : orders) {
            remember_algo_cover_policy(order);
            auto result = execution_post("/send", order);
            if (!result || result->status < 200 || result->status >= 300) {
                status = 503;
                const auto detail = result ? result->body : std::string("cerious exchange unavailable");
                append_algo_audit("DEPLOY ERROR exchange send failed: " + detail);
                return "{\"ok\":false,\"acceptedCount\":0,\"detail\":\"cerious exchange unavailable while sending algo order\",\"state\":"
                    + latest_state + "}";
            }
            process_exchange_fill_events(result->body);
            latest_state = execution_state_json();
        }

        std::ostringstream out;
        out << "{\"ok\":true,\"runtime\":\"cpp\",\"acceptedCount\":" << orders.size()
            << ",\"notes\":[";
        for (std::size_t i = 0; i < notes.size(); ++i) {
            if (i) out << ",";
            out << q(notes[i]);
        }
        out << "],\"state\":" << latest_state << "}";
        return out.str();
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

    void send_json_file(httplib::Response& res, const fs::path& path, const std::string& service_name) const {
        const auto body = read_text(path);
        if (!body) {
            send_json(res, "{\"ok\":false,\"service\":" + q(service_name) + ",\"detail\":\"payload file missing\"}", 404);
            return;
        }
        send_json(res, *body);
    }

    bool safe_cerious_content_kind(const std::string& kind) const {
        static const std::vector<std::string> allowed = {
            "atrZScoreEngine",
            "executionRules",
            "orderLayeringTechniques",
            "moneyManagement",
            "riskChecklist",
            "sourceNotes",
            "modelResearchGovernance",
            "liveApiArchitecture"
        };
        return std::find(allowed.begin(), allowed.end(), kind) != allowed.end();
    }

    bool is_allowed_cors_origin(const std::string& origin) const {
        if (origin.empty()) return false;
        return origin == "http://127.0.0.1:8000"
            || origin == "http://localhost:8000"
            || origin == "http://127.0.0.1:5173"
            || origin == "http://localhost:5173";
    }

    void apply_cors(const httplib::Request& req, httplib::Response& res) const {
        const auto origin_it = req.headers.find("Origin");
        const auto origin = origin_it == req.headers.end() ? std::string{} : origin_it->second;
        if (is_allowed_cors_origin(origin)) {
            res.set_header("Access-Control-Allow-Origin", origin);
            res.set_header("Vary", "Origin");
        }
        res.set_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        res.set_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Cerious-Session");
        res.set_header("Access-Control-Max-Age", "600");
    }

    void register_routes(httplib::Server& server) {
        server.set_pre_routing_handler([&](const httplib::Request& req, httplib::Response& res) {
            apply_cors(req, res);
            if (req.method == "OPTIONS") {
                res.status = 204;
                return httplib::Server::HandlerResponse::Handled;
            }
            return httplib::Server::HandlerResponse::Unhandled;
        });

        server.Get("/api/health", [&](const httplib::Request&, httplib::Response& res) {
            const auto exchange = execution_get("/health");
            const bool exchange_ok = exchange && exchange->status >= 200 && exchange->status < 300;
            send_json(res,
                "{\"ok\":true,\"app\":\"cerious-systems\",\"runtime\":\"cpp\","
                "\"gateway\":\"cerious_gateway\",\"backend\":\"native-cpp\","
                "\"exchange\":" + std::string(exchange_ok ? "true" : "false")
                + ",\"marketData\":" + market_data_status_json()
                + ",\"execution\":" + execution_status_json() + "}");
        });

        server.Get("/health", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, "{\"ok\":true,\"app\":\"cerious-systems\",\"runtime\":\"cpp\"}");
        });

        server.Post("/api/auth/login", [&](const httplib::Request& req, httplib::Response& res) {
            const auto username = trim_copy(get_string(req.body, "username", ""));
            const auto password = trim_copy(get_string(req.body, "password", ""));
            if (!valid_login(username, password)) {
                send_json(res, "{\"ok\":false,\"detail\":\"Invalid username or password\"}", 401);
                return;
            }
            send_json(res, auth_success_json(username));
        });

        server.Post("/api/auth/auto", [&](const httplib::Request&, httplib::Response& res) {
            auto username = portal_username();
            if (trim_copy(portal_password()).empty()) {
                username = admin_username();
            }
            if (trim_copy(username).empty()) {
                send_json(res, "{\"ok\":false,\"detail\":\"Local auth is not configured\"}", 503);
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
            send_json(res, "{\"ok\":true,\"runtime\":\"cpp\",\"services\":[\"gateway\",\"cerious-exchange\"]}");
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
                "\"executionDestination\":\"cerious-exchange\",\"stateOwner\":\"cerious.exchange\"}");
        });

        server.Post("/api/system/warmup", [&](const httplib::Request&, httplib::Response& res) {
            const auto started = now_ms();
            (void)cerious_advisory_snapshot(true);
            const auto elapsed = now_ms() >= started ? now_ms() - started : 0;
            send_json(res, "{\"ok\":true,\"status\":\"ready\",\"runtime\":\"cpp\",\"warmupMs\":" + std::to_string(elapsed) + ",\"advisory\":\"ready\"}");
        });

        server.Post("/api/system/shutdown", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, "{\"ok\":true,\"runtime\":\"cpp\",\"shutdown\":\"requested\"}");
            execution_post("/shutdown", "{}");
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

        server.Post("/api/algo-manager/deploy", [&](const httplib::Request& req, httplib::Response& res) {
            int status = 200;
            send_json(res, deploy_algo_definitions_json(req.body, status), status);
        });

        server.Post("/api/algo-definitions/save", [&](const httplib::Request& req, httplib::Response& res) {
            const auto definition = get_object(req.body, "definition").value_or(req.body);
            const auto id = get_string(definition, "id", "algo-" + std::to_string(now_ms()));
            const auto dir = data / "algo-definitions";
            std::error_code ec;
            fs::create_directories(dir, ec);
            const auto path = dir / (id + ".json");
            const bool ok = write_text(path, definition);
            send_json(res, ok ? "{\"ok\":true,\"runtime\":\"cpp\"}" : "{\"ok\":false,\"detail\":\"algo definition save failed\"}", ok ? 200 : 500);
        });

        server.Post("/api/order", [&](const httplib::Request& req, httplib::Response& res) {
            const auto order_id = order_id_from_payload(req.body);
            if (order_id.empty()) {
                send_json(res,
                    "{\"ok\":false,\"detail\":\"orderId required\",\"service\":\"cerious.gateway\",\"state\":"
                    + execution_state_json() + "}",
                    400);
                return;
            }
            const auto order_body = payload_with_order_id(req.body, order_id);
            remember_algo_cover_policy(order_body);
            auto result = execution_post("/send", order_body);
            if (!result) {
                send_json(res, "{\"ok\":false,\"detail\":\"cerious exchange unavailable\",\"state\":" + execution_state_json() + "}", 503);
                return;
            }
            if (result->status >= 200 && result->status < 300) {
                process_exchange_fill_events(result->body);
            }
            if (result->status >= 200 && result->status < 300) {
                send_json(res, wrap_execution_event(result->body), result->status);
            } else {
                send_json(res, "{\"ok\":false,\"detail\":\"cerious exchange rejected order\",\"event\":"
                    + result->body + ",\"state\":" + execution_state_json() + "}", result->status);
            }
        });

        server.Post(R"(/api/cerious/orders/([^/]+)/cancel)", [&](const httplib::Request& req, httplib::Response& res) {
            const std::string order_id = req.matches[1];
            auto result = execution_post("/cancel", "{\"orderId\":" + q(order_id) + "}");
            if (!result) {
                send_json(res, "{\"ok\":false,\"detail\":\"cerious exchange unavailable\",\"state\":" + execution_state_json() + "}", 503);
                return;
            }
            if (result->status >= 200 && result->status < 300) {
                send_json(res, wrap_execution_event(result->body), result->status);
            } else {
                send_json(res, "{\"ok\":false,\"detail\":\"cerious exchange rejected cancel\",\"event\":"
                    + result->body + ",\"state\":" + execution_state_json() + "}", result->status);
            }
        });

        server.Post("/api/cerious/orders/cancel-all", [&](const httplib::Request&, httplib::Response& res) {
            auto result = execution_post("/reset", "{\"clearFills\":false,\"reason\":\"cancel all working orders\"}");
            if (!result) {
                send_json(res, "{\"ok\":false,\"detail\":\"cerious exchange unavailable\",\"state\":" + execution_state_json() + "}", 503);
                return;
            }
            if (result->status >= 200 && result->status < 300) {
                send_json(res, wrap_execution_event(result->body), result->status);
            } else {
                send_json(res, "{\"ok\":false,\"detail\":\"cerious exchange rejected cancel-all\",\"event\":"
                    + result->body + ",\"state\":" + execution_state_json() + "}", result->status);
            }
        });

        server.Post("/api/cerious/session/reset", [&](const httplib::Request& req, httplib::Response& res) {
            {
                std::lock_guard<std::mutex> lock(algo_cover_mutex);
                algo_cover_policies.clear();
                processed_sim_fill_events.clear();
            }
            auto result = execution_post("/reset", req.body.empty() ? "{\"clearFills\":true}" : req.body);
            if (!result) {
                send_json(res, "{\"ok\":false,\"detail\":\"cerious exchange unavailable\",\"state\":" + execution_state_json() + "}", 503);
                return;
            }
            if (result->status >= 200 && result->status < 300) {
                send_json(res, wrap_execution_event(result->body), result->status);
            } else {
                send_json(res, "{\"ok\":false,\"detail\":\"cerious exchange rejected reset\",\"event\":"
                    + result->body + ",\"state\":" + execution_state_json() + "}", result->status);
            }
        });

        server.Get("/api/cerious/positions-orders", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, execution_state_json());
        });

        const auto cerious_window_payloads = data / "window-payloads" / "cerious";

        server.Get("/api/cerious/intelligence", [&, cerious_window_payloads](const httplib::Request&, httplib::Response& res) {
            (void)cerious_window_payloads;
            send_json(res, cerious_intelligence_json());
        });

        server.Get("/api/cerious/daily-summary", [&, cerious_window_payloads](const httplib::Request&, httplib::Response& res) {
            (void)cerious_window_payloads;
            send_json(res, cerious_daily_summary_json());
        });

        server.Get("/api/cerious/subscriptions", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, cerious_subscription_model_json());
        });

        server.Get("/api/cerious/macro-regime", [&, cerious_window_payloads](const httplib::Request&, httplib::Response& res) {
            (void)cerious_window_payloads;
            send_json(res, cerious_macro_regime_json());
        });

        server.Get("/api/cerious/opportunity-map", [&, cerious_window_payloads](const httplib::Request&, httplib::Response& res) {
            (void)cerious_window_payloads;
            send_json(res, cerious_opportunity_map_json());
        });

        server.Get("/api/cerious/trade-analytics", [&, cerious_window_payloads](const httplib::Request&, httplib::Response& res) {
            send_json_file(res, cerious_window_payloads / "trade-analytics.json", "trade-analytics");
        });

        server.Get("/api/cerious/notional", [&, cerious_window_payloads](const httplib::Request&, httplib::Response& res) {
            send_json_file(res, cerious_window_payloads / "notional.json", "notional");
        });

        server.Get("/api/cerious/audit", [&, cerious_window_payloads](const httplib::Request&, httplib::Response& res) {
            send_json_file(res, cerious_window_payloads / "audit.json", "audit");
        });

        server.Get("/api/cerious/news", [&, cerious_window_payloads](const httplib::Request&, httplib::Response& res) {
            send_json_file(res, cerious_window_payloads / "news.json", "news");
        });

        server.Get(R"(/api/cerious/content/([^/]+))", [&, cerious_window_payloads](const httplib::Request& req, httplib::Response& res) {
            const auto kind = req.matches[1].str();
            if (!safe_cerious_content_kind(kind)) {
                send_json(res, "{\"ok\":false,\"detail\":\"Invalid content key\"}", 400);
                return;
            }
            send_json_file(res, cerious_window_payloads / "content" / (kind + ".json"), kind);
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
                    limit = std::clamp(std::stoi(req.get_param_value("limit")), 1, 1200);
                } catch (...) {
                    limit = 300;
                }
            }
            send_json(res, bars_json(symbol, interval, limit));
        });

        server.Get(R"(/api/studies/regression/([^/]+))", [&](const httplib::Request& req, httplib::Response& res) {
            const auto symbol = canonical_market_symbol(req.matches[1].str());
            const auto interval = req.has_param("interval") ? req.get_param_value("interval") : "30m";
            std::optional<int> lookback;
            double standard_deviations = 2.0;
            if (req.has_param("lookback")) {
                try {
                    const auto parsed = std::stoi(req.get_param_value("lookback"));
                    if (parsed >= 2) lookback = std::clamp(parsed, 2, 2000);
                } catch (...) {
                    lookback.reset();
                }
            }
            if (!lookback) {
                send_json(res, "{\"ok\":false,\"runtime\":\"cpp\",\"source\":\"cerious-study-service\",\"study\":\"linear-regression\",\"symbol\":"
                    + q(symbol) + ",\"interval\":" + q(interval)
                    + ",\"error\":\"regression lookback is required\"}", 400);
                return;
            }
            if (req.has_param("stdDev")) {
                try {
                    standard_deviations = std::clamp(std::stod(req.get_param_value("stdDev")), 0.0, 20.0);
                } catch (...) {
                    standard_deviations = 2.0;
                }
            }
            send_json(res, regression_study_json(symbol, interval, *lookback, standard_deviations));
        });

        server.Get("/api/metrics", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, "{\"ok\":true,\"runtime\":\"cpp\",\"metrics\":{}}");
        });

        server.Get("/api/alerts/sms/status", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, alert_smtp_status_json());
        });

        server.Post("/api/alerts/sms", [&](const httplib::Request& req, httplib::Response& res) {
            int status = 200;
            const auto response = send_smtp_text_alert(req.body, status);
            send_json(res, response.value_or("{\"ok\":false,\"error\":\"SMS alert transport unavailable\"}"), status);
        });

        server.Get(R"(/api/.*)", [&](const httplib::Request&, httplib::Response& res) {
            send_json(res, "{\"ok\":false,\"runtime\":\"cpp\",\"error\":\"not_found\"}", 404);
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
            res.set_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
            res.set_header("Pragma", "no-cache");
            res.set_header("Expires", "0");
            res.set_content(*content, content_type_for(target));
        });
    }
};

} // namespace

int main(int argc, char** argv) {
    auto args = parse_args(argc, argv);
    load_dotenv_file(fs::current_path() / ".env");
    load_dotenv_file(args.root / ".env");
    if (argc > 0 && argv[0] && std::string(argv[0]).find_first_of("\\/") != std::string::npos) {
        std::error_code ec;
        const auto exe_dir = fs::absolute(fs::path(argv[0]), ec).parent_path();
        if (!ec) {
            load_dotenv_file(exe_dir / ".env");
            load_dotenv_file(exe_dir.parent_path() / ".env");
            load_dotenv_file(exe_dir.parent_path().parent_path() / ".env");
            load_dotenv_file(exe_dir.parent_path().parent_path().parent_path() / ".env");
            load_dotenv_file(exe_dir.parent_path().parent_path().parent_path().parent_path() / ".env");
        }
    }
    Gateway gateway(args);

    httplib::Server server;
    server.new_task_queue = [] {
        return new httplib::ThreadPool(32, 512);
    };
    server.set_read_timeout(10, 0);
    server.set_write_timeout(10, 0);
    server.set_idle_interval(1, 0);

    gateway.start_market_data();
    gateway.start_cerious_advisory_refresh();
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
