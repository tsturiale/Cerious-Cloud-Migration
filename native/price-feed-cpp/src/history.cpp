#include <cstdlib>
#include <databento/constants.hpp>
#include <databento/datetime.hpp>
#include <databento/dbn_store.hpp>
#include <databento/enums.hpp>
#include <databento/historical.hpp>
#include <databento/record.hpp>
#include <databento/symbol_map.hpp>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace db = databento;

namespace {

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

std::uint64_t arg_u64(int argc, char** argv, const std::string& name, const std::uint64_t fallback) {
  const auto value = arg_value(argc, argv, name, "");
  if (value.empty()) {
    return fallback;
  }
  try {
    return static_cast<std::uint64_t>(std::stoull(value));
  } catch (...) {
    return fallback;
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

db::Schema parse_schema(const std::string& schema) {
  if (schema == "ohlcv-1s" || schema == "ohlcv1s") {
    return db::Schema::Ohlcv1S;
  }
  if (schema == "ohlcv-1h" || schema == "ohlcv1h") {
    return db::Schema::Ohlcv1H;
  }
  if (schema == "ohlcv-1d" || schema == "ohlcv1d") {
    return db::Schema::Ohlcv1D;
  }
  if (schema == "trades") {
    return db::Schema::Trades;
  }
  return db::Schema::Ohlcv1M;
}

std::string schema_name(const db::Schema schema) {
  switch (schema) {
    case db::Schema::Ohlcv1S:
      return "ohlcv-1s";
    case db::Schema::Ohlcv1H:
      return "ohlcv-1h";
    case db::Schema::Ohlcv1D:
      return "ohlcv-1d";
    case db::Schema::Trades:
      return "trades";
    default:
      return "ohlcv-1m";
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

void publish_ohlcv_json(const std::string& schema, const std::string& symbol, const db::OhlcvMsg& msg) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(9);
  out << "{"
      << "\"type\":\"market.ohlcv\","
      << "\"dataset\":\"GLBX.MDP3\","
      << "\"schema\":\"" << schema << "\","
      << "\"symbol\":\"" << json_escape(symbol) << "\","
      << "\"instrumentId\":" << msg.hd.instrument_id << ","
      << "\"tsEventNs\":" << msg.hd.ts_event.time_since_epoch().count() << ","
      << "\"open\":" << db_price_to_double(msg.open) << ","
      << "\"high\":" << db_price_to_double(msg.high) << ","
      << "\"low\":" << db_price_to_double(msg.low) << ","
      << "\"close\":" << db_price_to_double(msg.close) << ","
      << "\"volume\":" << msg.volume
      << "}" << std::endl;
  std::cout << out.str();
}

void publish_trade_json(const std::string& symbol, const db::TradeMsg& msg) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(9);
  out << "{"
      << "\"type\":\"market.trade\","
      << "\"dataset\":\"GLBX.MDP3\","
      << "\"schema\":\"trades\","
      << "\"symbol\":\"" << json_escape(symbol) << "\","
      << "\"instrumentId\":" << msg.hd.instrument_id << ","
      << "\"tsEventNs\":" << msg.hd.ts_event.time_since_epoch().count() << ","
      << "\"price\":" << db_price_to_double(msg.price) << ","
      << "\"size\":" << msg.size
      << "}" << std::endl;
  std::cout << out.str();
}

}  // namespace

int main(int argc, char** argv) {
  if (std::getenv("DATABENTO_API_KEY") == nullptr) {
    std::cerr << "DATABENTO_API_KEY is required." << std::endl;
    return 2;
  }

  const auto symbols_arg = arg_value(argc, argv, "--symbols", "ES.v.0");
  const auto start = arg_value(argc, argv, "--start", "");
  const auto end = arg_value(argc, argv, "--end", "");
  const auto schema_arg = arg_value(argc, argv, "--schema", "ohlcv-1m");
  const auto stype_arg = arg_value(argc, argv, "--stype", "continuous");
  const auto limit = arg_u64(argc, argv, "--limit", 1000);
  const auto symbols = split_symbols(symbols_arg);
  const auto schema = parse_schema(schema_arg);
  const auto stype = parse_stype(stype_arg);
  const auto normalized_schema = schema_name(schema);

  if (start.empty() || end.empty()) {
    std::cerr << "--start and --end are required, for example --start 2026-06-16T14:30 --end 2026-06-16T15:00" << std::endl;
    return 2;
  }
  if (symbols.empty()) {
    std::cerr << "No symbols configured." << std::endl;
    return 2;
  }

  std::cerr << "cerious_price_history starting dataset=GLBX.MDP3 schema=" << normalized_schema
            << " stype=" << stype_arg << " symbols=" << symbols_arg
            << " start=" << start << " end=" << end << " limit=" << limit << std::endl;

  auto client = db::Historical::Builder().SetKeyFromEnv().Build();
  auto store = client.TimeseriesGetRange(
      db::dataset::kGlbxMdp3,
      db::DateTimeRange<std::string>{start, end},
      symbols,
      schema,
      stype,
      db::SType::InstrumentId,
      limit);
  auto symbol_map = store.GetMetadata().CreateSymbolMap();

  while (const auto* record = store.NextRecord()) {
    if (schema == db::Schema::Trades) {
      const auto& trade = record->Get<db::TradeMsg>();
      publish_trade_json(symbol_map.At(trade), trade);
      continue;
    }
    const auto& bar = record->Get<db::OhlcvMsg>();
    publish_ohlcv_json(normalized_schema, symbol_map.At(bar), bar);
  }

  return 0;
}
