// json.h — deliberately-tiny JSON reader.
//
// Just enough to pull scalar values and array-of-objects out of the
// polling responses. Not a full parser; if a field's structure is
// unusual it silently returns "". Bringing in a real parser (nlohmann,
// rapidjson) would double the binary size for no gain here.
#pragma once
#include <string>
#include <vector>

namespace json {
    // Return the STRING value for `key` inside a top-level object. If
    // the value is a number/bool/null it returns the raw literal
    // (e.g. "true", "42"). Missing → "".
    std::string get_str(const std::string& obj, const std::string& key);

    // Return the raw substring for `key`'s value, brackets/braces
    // included when it's an array or object. Missing → "".
    std::string get_raw(const std::string& obj, const std::string& key);

    // Split an array under `key` into a vector of each element's raw
    // JSON. Handles nested {} and [] correctly with string awareness.
    std::vector<std::string> get_object_array(const std::string& obj,
                                              const std::string& key);

    // Parse a number field. Returns `def` when missing/malformed.
    double get_num(const std::string& obj, const std::string& key, double def);
}
