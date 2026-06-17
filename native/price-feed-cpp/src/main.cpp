#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
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
  std::atomic_int emitted_records{0};

  if (symbols.empty()) {
    std::cerr << "No symbols configured." << std::endl;
    return 2;
  }
  if (std::getenv("DATABENTO_API_KEY") == nullptr) {
    std::cerr << "DATABENTO_API_KEY is required." << std::endl;
    return 2;
  }

  std::cerr << "cerious_price_feed starting dataset=GLBX.MDP3 schema=mbp-1 stype="
            << stype_arg << " symbols=" << symbols_arg << std::endl;

  db::PitSymbolMap symbol_map;
  auto client = db::LiveThreaded::Builder()
                    .SetKeyFromEnv()
                    .SetDataset(db::Dataset::GlbxMdp3)
                    .SetCompression(db::Compression::Zstd)
                    .BuildThreaded();

  client.Subscribe(symbols, db::Schema::Definition, stype);
  client.Subscribe(symbols, db::Schema::Mbp1, stype);

  auto handler = [&symbol_map, &emitted_records, max_records](const db::Record& rec) {
    if (auto* mapping = rec.GetIf<db::SymbolMappingMsg>()) {
      symbol_map.OnSymbolMapping(*mapping);
      std::cerr << "symbol mapping received" << std::endl;
    } else if (auto* definition = rec.GetIf<db::InstrumentDefMsg>()) {
      symbol_map.OnRecord(rec);
      std::cerr << "definition instrument_id=" << definition->hd.instrument_id << std::endl;
    } else if (auto* msg = rec.GetIf<db::Mbp1Msg>()) {
      symbol_map.OnRecord(rec);
      publish_mbp1_json(symbol_map[msg->hd.instrument_id], *msg);
      const auto count = ++emitted_records;
      if (max_records > 0 && count >= max_records) {
        g_running.store(false);
        return db::KeepGoing::Stop;
      }
    } else if (auto* system_msg = rec.GetIf<db::SystemMsg>()) {
      if (!system_msg->IsHeartbeat()) {
        std::cerr << "system " << system_msg->Msg() << std::endl;
      }
    } else if (auto* error = rec.GetIf<db::ErrorMsg>()) {
      std::cerr << "databento error " << error->Err() << std::endl;
    } else {
      std::cerr << "ignored rtype=" << db::ToString(rec.RType()) << std::endl;
    }
    return db::KeepGoing::Continue;
  };

  auto exception_handler = [](const std::exception& error) {
    std::cerr << "databento exception " << error.what() << "; restarting session" << std::endl;
    return db::LiveThreaded::ExceptionAction::Restart;
  };

  auto metadata_handler = [](db::Metadata&& metadata) {
    std::cerr << metadata << std::endl;
  };

  client.Start(metadata_handler, handler, exception_handler);
  std::cerr << "databento live session started" << std::endl;

  while (g_running.load()) {
    std::this_thread::sleep_for(std::chrono::milliseconds{100});
  }

  client.BlockForStop(std::chrono::milliseconds{1000});
  return 0;
}
