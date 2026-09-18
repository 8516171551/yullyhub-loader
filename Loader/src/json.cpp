#include "pch.h"
#include "json.h"

namespace json {

// Walk past whitespace / commas.
static size_t skip_ws(const std::string& s, size_t p) {
    while (p < s.size() && (s[p] == ' ' || s[p] == '\t' || s[p] == '\n' ||
                            s[p] == '\r' || s[p] == ','))
        ++p;
    return p;
}

// Find "key": and return the position of the first char of the VALUE.
static size_t find_value_start(const std::string& obj, const std::string& key) {
    std::string needle = "\"" + key + "\"";
    size_t p = obj.find(needle);
    if (p == std::string::npos) return std::string::npos;
    p = obj.find(':', p);
    if (p == std::string::npos) return std::string::npos;
    return skip_ws(obj, p + 1);
}

std::string get_str(const std::string& obj, const std::string& key) {
    size_t p = find_value_start(obj, key);
    if (p == std::string::npos || p >= obj.size()) return "";
    if (obj[p] == '"') {
        // String value: walk to closing quote, handling escapes.
        ++p;
        std::string out;
        while (p < obj.size() && obj[p] != '"') {
            if (obj[p] == '\\' && p + 1 < obj.size()) {
                char c = obj[p + 1];
                switch (c) {
                    case 'n':  out.push_back('\n'); break;
                    case 't':  out.push_back('\t'); break;
                    case 'r':  out.push_back('\r'); break;
                    case '"':  out.push_back('"');  break;
                    case '\\': out.push_back('\\'); break;
                    case '/':  out.push_back('/');  break;
                    default:   out.push_back(c);    break;
                }
                p += 2;
            } else {
                out.push_back(obj[p++]);
            }
        }
        return out;
    }
    // Number / bool / null literal — return raw token.
    size_t start = p;
    while (p < obj.size() && obj[p] != ',' && obj[p] != '}' && obj[p] != ']' &&
           obj[p] != ' ' && obj[p] != '\n' && obj[p] != '\r' && obj[p] != '\t') ++p;
    return obj.substr(start, p - start);
}

std::string get_raw(const std::string& obj, const std::string& key) {
    size_t p = find_value_start(obj, key);
    if (p == std::string::npos || p >= obj.size()) return "";
    char open = obj[p];
    if (open != '[' && open != '{') return get_str(obj, key);
    char close = (open == '[') ? ']' : '}';
    size_t start = p;
    int depth = 0;
    bool inStr = false, esc = false;
    while (p < obj.size()) {
        char c = obj[p];
        if (esc) { esc = false; ++p; continue; }
        if (c == '\\') { esc = true; ++p; continue; }
        if (c == '"') { inStr = !inStr; ++p; continue; }
        if (!inStr) {
            if (c == open)  ++depth;
            else if (c == close) {
                --depth;
                if (depth == 0) return obj.substr(start, p - start + 1);
            }
        }
        ++p;
    }
    return "";
}

std::vector<std::string> get_object_array(const std::string& obj,
                                          const std::string& key) {
    std::vector<std::string> out;
    size_t p = find_value_start(obj, key);
    if (p == std::string::npos || obj[p] != '[') return out;
    ++p;
    while (p < obj.size()) {
        p = skip_ws(obj, p);
        if (p >= obj.size() || obj[p] == ']') break;
        if (obj[p] != '{') break;
        size_t start = p;
        int depth = 0;
        bool inStr = false, esc = false;
        while (p < obj.size()) {
            char c = obj[p];
            if (esc) { esc = false; ++p; continue; }
            if (c == '\\') { esc = true; ++p; continue; }
            if (c == '"') { inStr = !inStr; ++p; continue; }
            if (!inStr) {
                if (c == '{') ++depth;
                else if (c == '}') { --depth; if (depth == 0) { ++p; break; } }
            }
            ++p;
        }
        out.push_back(obj.substr(start, p - start));
    }
    return out;
}

double get_num(const std::string& obj, const std::string& key, double def) {
    size_t p = find_value_start(obj, key);
    if (p == std::string::npos || p >= obj.size()) return def;
    return atof(obj.c_str() + p);
}

} // namespace json
