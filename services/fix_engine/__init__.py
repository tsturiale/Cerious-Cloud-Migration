# Cerious FIX Engine — Python UI proxy.
#
# The actual FIX engine is a standalone C++ daemon at native/fix-engine-cpp/.
# This Python package is ONLY a thin HTTP client that proxies UI traffic
# to the C++ daemon's REST API. Zero FIX logic lives in Python.
