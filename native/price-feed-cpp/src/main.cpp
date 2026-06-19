#include <atomic>
#include <algorithm>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <exception>
#include <databento/constants.hpp>
#include <databento/dbn.hpp>
#include <databento/enums.hpp>
#include <databento/live.hpp>
#include <databento/live_threaded.hpp>
#include <databento/pretty.hpp>
#include <databento/record.hpp>
#include <databento/symbol_map.hpp>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace db = databento;

namespace {

std::atomic_bool g_running{true};

void handle_signal(int) {
  g_running.store(false);
}

std::uint64_t epoch_ms() {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch()).count());
}

std::vector<std::string> split_symbols(const std::string& input) {
  std::vector<std::string> result;
  std::string current;
  for (const char ch : input) {
    if (ch == ',') {
      if (!current.empty()) {
        result.push_back(current);
        current.clear();
      }
      continue;
    }
    if (ch != ' ') {
      current.push_back(ch);
    }
  }
  if (!current.empty()) {
    result.push_back(current);
  }
  return result;
}

std::string arg_value(int argc, char** argv, const std::string& name, const std::string& fallback) {
  for (int i = 1; i + 1 < argc; ++i) {
    if (argv[i] == name) {
      return argv[i + 1];
    }
  }
  return fallback;
}

int arg_int(int argc, char** argv, const std::string& name, const int fallback) {
  const auto value = arg_value(argc, argv, name, "");
  if (value.empty()) {
    return fallback;
  }
  try {
    return std::stoi(value);
  } catch (...) {
    return fallback;
  }
}

int env_int(const char* key, const int fallback) {
  const char* value = std::getenv(key);
  if (value == nullptr || *value == '\0') {
    return fallback;
  }
  try {
    return std::stoi(value);
  } catch (...) {
    return fallback;
  }
}

double db_price_to_double(const std::int64_t value) {
  if (value == db::kUndefPrice) {
    return 0.0;
  }
  return static_cast<double>(value) / 1000000000.0;
}

std::string json_escape(const std::string& text) {
  std::ostringstream out;
  for (const char ch : text) {
    switch (ch) {
      case '\\':
        out << "\\\\";
        break;
      case '"':
        out << "\\\"";
        break;
      case '\n':
        out << "\\n";
        break;
      case '\r':
        out << "\\r";
        break;
      case '\t':
        out << "\\t";
        break;
      default:
        out << ch;
        break;
    }
  }
  return out.str();
}

std::string system_status_for(const std::string& message, const bool heartbeat) {
  if (heartbeat) {
    return "heartbeat";
  }
  if (message.find("Subscription request") != std::string::npos &&
      message.find("succeeded") != std::string::npos) {
    return "subscription_ack";
  }
  if (message.find("Slow reader") != std::string::npos ||
      message.find("slow reader") != std::string::npos) {
    return "slow_reader_warning";
  }
  if (message.find("End of interval") != std::string::npos) {
    return "end_of_interval";
  }
  if (message.find("Replay completed") != std::string::npos ||
      message.find("Finished") != std::string::npos) {
    return "replay_completed";
  }
  return "system";
}

void publish_status_json(const std::string& status,
                         const std::string& detail = "",
                         const std::string& symbol = "",
                         const std::uint32_t instrument_id = 0,
                         const int mappings = -1,
                         const int definitions = -1,
                         const int records = -1) {
  std::ostringstream out;
  out << "{"
      << "\"type\":\"market.status\","
      << "\"provider\":\"databento\","
      << "\"dataset\":\"GLBX.MDP3\","
      << "\"schema\":\"mbp-1\","
      << "\"status\":\"" << json_escape(status) << "\","
      << "\"tsMs\":" << epoch_ms();
  if (!detail.empty()) {
    out << ",\"detail\":\"" << json_escape(detail) << "\"";
  }
  if (!symbol.empty()) {
    out << ",\"symbol\":\"" << json_escape(symbol) << "\"";
  }
  if (instrument_id != 0) {
    out << ",\"instrumentId\":" << instrument_id;
  }
  if (mappings >= 0) {
    out << ",\"mappings\":" << mappings;
  }
  if (definitions >= 0) {
    out << ",\"definitions\":" << definitions;
  }
  if (records >= 0) {
    out << ",\"records\":" << records;
  }
  out << "}" << std::endl;
  std::cout << out.str();
  std::cout.flush();
}

std::string action_to_code(const db::Action action) {
  switch (action) {
    case db::Action::Trade:
      return "T";
    case db::Action::Add:
      return "A";
    case db::Action::Modify:
      return "M";
    case db::Action::Cancel:
      return "C";
    case db::Action::Clear:
      return "R";
    case db::Action::Fill:
      return "F";
    default:
      return "N";
  }
}

std::string side_to_code(const db::Side side) {
  switch (side) {
    case db::Side::Bid:
      return "B";
    case db::Side::Ask:
      return "A";
    default:
      return "N";
  }
}

db::SType parse_stype(const std::string& stype) {
  if (stype == "parent") {
    return db::SType::Parent;
  }
  if (stype == "raw" || stype == "raw_symbol" || stype == "raw-symbol") {
    return db::SType::RawSymbol;
  }
  return db::SType::Continuous;
}

void publish_mbp1_json(const std::string& symbol, const db::Mbp1Msg& msg) {
  const auto& level0 = msg.levels[0];
  std::ostringstream out;
  out << std::fixed << std::setprecision(9);
  out << "{"
      << "\"type\":\"market.mbp1\","
      << "\"dataset\":\"GLBX.MDP3\","
      << "\"schema\":\"mbp-1\","
      << "\"symbol\":\"" << json_escape(symbol) << "\","
      << "\"instrumentId\":" << msg.hd.instrument_id << ","
      << "\"tsEventNs\":" << msg.hd.ts_event.time_since_epoch().count() << ","
      << "\"tsRecvNs\":" << msg.ts_recv.time_since_epoch().count() << ","
      << "\"sequence\":" << msg.sequence << ","
      << "\"action\":\"" << action_to_code(msg.action) << "\","
      << "\"side\":\"" << side_to_code(msg.side) << "\","
      << "\"price\":" << db_price_to_double(msg.price) << ","
      << "\"size\":" << msg.size << ","
      << "\"bid\":" << db_price_to_double(level0.bid_px) << ","
      << "\"ask\":" << db_price_to_double(level0.ask_px) << ","
      << "\"bidSize\":" << level0.bid_sz << ","
      << "\"askSize\":" << level0.ask_sz << ","
      << "\"bidCount\":" << level0.bid_ct << ","
      << "\"askCount\":" << level0.ask_ct
      << "}" << std::endl;
  std::cout << out.str();
  std::cout.flush();
}

}  // namespace

int main(int argc, char** argv) {
  std::signal(SIGINT, handle_signal);
  std::signal(SIGTERM, handle_signal);

  const auto symbols_arg = arg_value(argc, argv, "--symbols", "ES.v.0,NQ.v.0,YM.v.0,RTY.v.0,CL.v.0,GC.v.0,ZM.v.0,ZS.v.0");
  const auto symbols = split_symbols(symbols_arg);
  const auto stype_arg = arg_value(argc, argv, "--stype", "continuous");
  const auto stype = parse_stype(stype_arg);
  const auto max_records = arg_int(argc, argv, "--max-records", 0);
  const auto stale_ms = arg_int(argc, argv, "--stale-ms", env_int("CERIOUS_PRICE_FEED_STALE_MS", 30000));
  const auto reconnect_ms = arg_int(argc, argv, "--reconnect-ms", env_int("CERIOUS_PRICE_FEED_RECONNECT_MS", 5000));
  const auto max_reconnect_ms = arg_int(argc, argv, "--max-reconnect-ms", env_int("CERIOUS_PRICE_FEED_MAX_RECONNECT_MS", 60000));
  std::atomic_int emitted_records{0};

  if (symbols.empty()) {
    publish_status_json("error", "no symbols configured");
    std::cerr << "No symbols configured." << std::endl;
    return 2;
  }
  if (std::getenv("DATABENTO_API_KEY") == nullptr) {
    publish_status_json("error", "DATABENTO_API_KEY is required");
    std::cerr << "DATABENTO_API_KEY is required." << std::endl;
    return 2;
  }

  publish_status_json("starting", "creating Databento live client");
  std::cerr << "cerious_price_feed starting dataset=GLBX.MDP3 schema=mbp-1 stype="
            << stype_arg << " symbols=" << symbols_arg << " stale_ms=" << stale_ms
            << " reconnect_ms=" << reconnect_ms
            << " max_reconnect_ms=" << max_reconnect_ms << std::endl;

  int attempt = 0;
  int current_reconnect_ms = std::max(1000, reconnect_ms);
  while (g_running.load()) {
    ++attempt;
    db::PitSymbolMap symbol_map;
    int symbol_mappings = 0;
    int definitions = 0;
    bool gateway_signal_received = false;
    auto last_record_clock = std::chrono::steady_clock::now();

    try {
      publish_status_json("starting", "creating Databento live session attempt " + std::to_string(attempt));
      auto client = db::LiveBlocking::Builder()
                        .SetKeyFromEnv()
                        .SetDataset(db::Dataset::GlbxMdp3)
                        .SetCompression(db::Compression::Zstd)
                        .SetHeartbeatInterval(std::chrono::seconds{10})
                        .BuildBlocking();

      client.Subscribe(symbols, db::Schema::Definition, stype);
      client.Subscribe(symbols, db::Schema::Mbp1, stype);
      publish_status_json("subscription_requested", symbols_arg);

      const auto metadata = client.Start();
      publish_status_json("metadata", "metadata received");
      std::cerr << metadata << std::endl;
      publish_status_json("session_started", "Databento live session started");
      std::cerr << "databento live session started attempt=" << attempt << std::endl;

      while (g_running.load()) {
        const auto* rec = client.NextRecord(std::chrono::milliseconds{1000});
        if (rec == nullptr) {
          const auto quiet_for = std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::steady_clock::now() - last_record_clock);
          if (quiet_for.count() >= stale_ms) {
            publish_status_json("stale_reconnect",
                                "no Databento record or heartbeat for " + std::to_string(quiet_for.count()) + "ms");
            std::cerr << "databento stale for " << quiet_for.count() << "ms; stopping session" << std::endl;
            client.Stop();
            break;
          }
          continue;
        }

        last_record_clock = std::chrono::steady_clock::now();
        const auto& record = *rec;
        if (auto* mapping = record.GetIf<db::SymbolMappingMsg>()) {
          gateway_signal_received = true;
          symbol_map.OnSymbolMapping(*mapping);
          const auto count = ++symbol_mappings;
          publish_status_json("symbol_mapping",
                              std::string(mapping->STypeInSymbol()) + "->" + mapping->STypeOutSymbol(),
                              mapping->STypeOutSymbol(),
                              mapping->hd.instrument_id,
                              count);
          std::cerr << "symbol mapping received" << std::endl;
        } else if (auto* definition = record.GetIf<db::InstrumentDefMsg>()) {
          gateway_signal_received = true;
          symbol_map.OnRecord(record);
          const auto count = ++definitions;
          publish_status_json("definition", "", "", definition->hd.instrument_id, -1, count);
          std::cerr << "definition instrument_id=" << definition->hd.instrument_id << std::endl;
        } else if (auto* msg = record.GetIf<db::Mbp1Msg>()) {
          gateway_signal_received = true;
          symbol_map.OnRecord(record);
          publish_mbp1_json(symbol_map[msg->hd.instrument_id], *msg);
          const auto count = ++emitted_records;
          if (count == 1 || count % 1000 == 0) {
            publish_status_json("record", "", symbol_map[msg->hd.instrument_id], msg->hd.instrument_id, -1, -1, count);
          }
          if (max_records > 0 && count >= max_records) {
            publish_status_json("stopped", "max records reached");
            g_running.store(false);
            client.Stop();
            break;
          }
        } else if (auto* system_msg = record.GetIf<db::SystemMsg>()) {
          gateway_signal_received = true;
          const std::string message = system_msg->Msg();
          publish_status_json(system_status_for(message, system_msg->IsHeartbeat()), message);
          if (!system_msg->IsHeartbeat()) {
            std::cerr << "system " << message << std::endl;
          }
        } else if (auto* error = record.GetIf<db::ErrorMsg>()) {
          gateway_signal_received = true;
          publish_status_json("error", error->Err());
          std::cerr << "databento error " << error->Err() << std::endl;
        } else {
          std::cerr << "ignored rtype=" << db::ToString(record.RType()) << std::endl;
        }
      }
    } catch (const std::exception& error) {
      publish_status_json("reconnecting", error.what());
      std::cerr << "databento session error " << error.what() << "; retrying" << std::endl;
    }

    if (g_running.load()) {
      const auto sleep_ms = gateway_signal_received ? std::max(1000, reconnect_ms) : current_reconnect_ms;
      publish_status_json("reconnecting", "retrying Databento live session in " + std::to_string(sleep_ms) + "ms");
      std::this_thread::sleep_for(std::chrono::milliseconds{sleep_ms});
      if (gateway_signal_received) {
        current_reconnect_ms = std::max(1000, reconnect_ms);
      } else {
        current_reconnect_ms = std::min(std::max(current_reconnect_ms * 2, current_reconnect_ms + 1000), std::max(current_reconnect_ms, max_reconnect_ms));
      }
    }
  }

  publish_status_json("stopped", "Databento live session stopped");
  return 0;
}
