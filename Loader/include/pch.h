// pch.h — common includes shared across every translation unit.
// Kept small so incremental builds don't blow up when we touch a header.
#pragma once

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <bcrypt.h>
#include <shellapi.h>
#include <rpc.h>
#include <winhttp.h>
#include <tlhelp32.h>
#include <psapi.h>
#include <winternl.h>

#include <string>
#include <vector>
#include <thread>
#include <chrono>
#include <mutex>
#include <atomic>
#include <iostream>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <algorithm>

#include "config.h"
#include "strings.h"
