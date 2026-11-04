#include <napi.h>
#include <windows.h>
#include <dwmapi.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>

bool GetWindowHandle(const Napi::Value& value, HWND* handle)
{
    if (value.IsBigInt()) {
        bool lossless = false;
        uint64_t rawHandle = value.As<Napi::BigInt>().Uint64Value(&lossless);
        if (!lossless) {
            return false;
        }
        *handle = reinterpret_cast<HWND>(static_cast<uintptr_t>(rawHandle));
        return true;
    }

    // Retain support for existing callers that pass special HWND values such
    // as HWND_TOPMOST (-1), while preferring BigInt for real window handles.
    if (value.IsNumber()) {
        double rawHandle = value.As<Napi::Number>().DoubleValue();
        if (!std::isfinite(rawHandle) || std::trunc(rawHandle) != rawHandle
            || rawHandle < static_cast<double>(INT64_MIN)
            || rawHandle > static_cast<double>(INT64_MAX)) {
            return false;
        }
        *handle = reinterpret_cast<HWND>(
          static_cast<intptr_t>(static_cast<int64_t>(rawHandle)));
        return true;
    }

    return false;
}

Napi::Boolean SetWindowPosition(const Napi::CallbackInfo& info)
{
    if (info.Length() < 7) {
        return Napi::Boolean::New(info.Env(), false);
    }

    HWND hwnd = NULL;
    HWND hwndAfter = NULL;
    if (!GetWindowHandle(info[0], &hwnd) || !GetWindowHandle(info[1], &hwndAfter)
        || !info[2].IsNumber() || !info[3].IsNumber() || !info[4].IsNumber()
        || !info[5].IsNumber() || !info[6].IsNumber()) {
        return Napi::Boolean::New(info.Env(), false);
    }

    BOOL result = SetWindowPos(hwnd,
                               hwndAfter,
                               info[2].As<Napi::Number>().Int32Value(),
                               info[3].As<Napi::Number>().Int32Value(),
                               info[4].As<Napi::Number>().Int32Value(),
                               info[5].As<Napi::Number>().Int32Value(),
                               info[6].As<Napi::Number>().Uint32Value());
    return Napi::Boolean::New(info.Env(), result != FALSE);
}

Napi::Object RectToObj(Napi::Env env, const RECT& rect)
{
    Napi::Object pos = Napi::Object::New(env);
    pos.Set("top", Napi::Number::New(env, rect.top));
    pos.Set("right", Napi::Number::New(env, rect.right));
    pos.Set("bottom", Napi::Number::New(env, rect.bottom));
    pos.Set("left", Napi::Number::New(env, rect.left));
    pos.Set("width", Napi::Number::New(env, rect.right - rect.left));
    pos.Set("height", Napi::Number::New(env, rect.bottom - rect.top));
    return pos;
}

Napi::Object GetWindowPosition(const Napi::CallbackInfo& info)
{
    HWND hwnd = NULL;
    if (info.Length() < 1 || !GetWindowHandle(info[0], &hwnd)) {
        return Napi::Object::New(info.Env());
    }

    RECT rect = {};
    if (!GetWindowRect(hwnd, &rect)) {
        return Napi::Object::New(info.Env());
    }
    return RectToObj(info.Env(), rect);
}

Napi::Object GetClientPosition(const Napi::CallbackInfo& info)
{
    HWND hwnd = NULL;
    if (info.Length() < 1 || !GetWindowHandle(info[0], &hwnd)) {
        return Napi::Object::New(info.Env());
    }

    RECT rect = {};
    if (!GetClientRect(hwnd, &rect)) {
        return Napi::Object::New(info.Env());
    }
    return RectToObj(info.Env(), rect);
}

Napi::Boolean GetWindowFullscreen(const Napi::CallbackInfo& info)
{
    HWND hwnd = NULL;
    if (info.Length() < 1 || !GetWindowHandle(info[0], &hwnd)) {
        return Napi::Boolean::New(info.Env(), false);
    }

    MONITORINFO monitorInfo = {};
    monitorInfo.cbSize = sizeof(MONITORINFO);
    HMONITOR monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY);
    if (monitor == NULL || !GetMonitorInfo(monitor, &monitorInfo)) {
        return Napi::Boolean::New(info.Env(), false);
    }

    RECT rect = {};
    if (!GetWindowRect(hwnd, &rect)) {
        return Napi::Boolean::New(info.Env(), false);
    }

    bool fullscreen = rect.left == monitorInfo.rcMonitor.left
        && rect.right == monitorInfo.rcMonitor.right
        && rect.top == monitorInfo.rcMonitor.top
        && rect.bottom == monitorInfo.rcMonitor.bottom;
    return Napi::Boolean::New(info.Env(), fullscreen);
}

Napi::BigInt GetForegroundWin(const Napi::CallbackInfo& info)
{
    HWND result = GetForegroundWindow();
    return Napi::BigInt::New(
      info.Env(), static_cast<uint64_t>(reinterpret_cast<uintptr_t>(result)));
}

Napi::Boolean SetForegroundWin(const Napi::CallbackInfo& info)
{
    HWND hwnd = NULL;
    if (info.Length() < 1 || !GetWindowHandle(info[0], &hwnd)) {
        return Napi::Boolean::New(info.Env(), false);
    }
    return Napi::Boolean::New(info.Env(), SetForegroundWindow(hwnd) != FALSE);
}

Napi::Number GetWinLong(const Napi::CallbackInfo& info)
{
    HWND hwnd = NULL;
    if (info.Length() < 2 || !GetWindowHandle(info[0], &hwnd) || !info[1].IsNumber()) {
        return Napi::Number::New(info.Env(), 0);
    }
    LONG_PTR result = GetWindowLongPtr(hwnd, info[1].As<Napi::Number>().Int32Value());
    return Napi::Number::New(info.Env(), static_cast<double>(result));
}

struct MoveWindowsContext {
    RECT from;
    RECT to;
    DWORD ownProcess;
    int moved;
    int failed;
};

bool IsMovableWindow(HWND hwnd, DWORD ownProcess)
{
    if (!IsWindowVisible(hwnd)) return false;

    DWORD process = 0;
    GetWindowThreadProcessId(hwnd, &process);
    if (process == ownProcess) return false;

    if (GetWindowLongPtr(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) return false;

    // Windows a person would move have titles. The rest are background surfaces.
    if (GetWindowTextLengthW(hwnd) == 0) return false;

    // Windows on other virtual desktops, and hidden shell surfaces
    DWORD cloaked = 0;
    if (SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked) return false;

    WCHAR className[64] = {};
    GetClassNameW(hwnd, className, 64);
    for (const auto shellClass : { L"Progman", L"WorkerW", L"Shell_TrayWnd", L"Shell_SecondaryTrayWnd" }) {
        if (wcscmp(className, shellClass) == 0) return false;
    }
    return true;
}

BOOL CALLBACK MoveWindowOffDisplay(HWND hwnd, LPARAM lParam)
{
    auto* context = reinterpret_cast<MoveWindowsContext*>(lParam);
    if (!IsMovableWindow(hwnd, context->ownProcess)) return TRUE;

    WINDOWPLACEMENT placement = {};
    placement.length = sizeof(WINDOWPLACEMENT);
    RECT current = {};
    if (!GetWindowPlacement(hwnd, &placement) || !GetWindowRect(hwnd, &current)) return TRUE;

    // A minimized window sits off-screen, so only its restored position counts
    const RECT& rect = (placement.showCmd == SW_SHOWMINIMIZED ? placement.rcNormalPosition : current);
    const POINT center = { rect.left + ((rect.right - rect.left) / 2), rect.top + ((rect.bottom - rect.top) / 2) };
    if (!PtInRect(&context->from, center)) return TRUE;

    // Keep it in the same relative spot, and shrink it if the other display is smaller
    RECT& normal = placement.rcNormalPosition;
    const LONG width = (std::min)(normal.right - normal.left, context->to.right - context->to.left);
    const LONG height = (std::min)(normal.bottom - normal.top, context->to.bottom - context->to.top);
    const LONG left = (std::min)((std::max)(normal.left - context->from.left + context->to.left, context->to.left), context->to.right - width);
    const LONG top = (std::min)((std::max)(normal.top - context->from.top + context->to.top, context->to.top), context->to.bottom - height);
    normal = { left, top, left + width, top + height };

    // A maximized window stays put when given a new position, so it has to be
    // restored, moved, and maximized again. These are all queued on the window's
    // own thread, in order, so a window that has stopped responding can't hang the app.
    if (placement.showCmd == SW_SHOWMAXIMIZED) {
        const bool moved = ShowWindowAsync(hwnd, SW_RESTORE)
            && SetWindowPos(hwnd, NULL, left, top, width, height, SWP_ASYNCWINDOWPOS | SWP_NOZORDER | SWP_NOACTIVATE)
            && ShowWindowAsync(hwnd, SW_SHOWMAXIMIZED);
        if (moved) {
            context->moved++;
        } else {
            context->failed++;
        }
        return TRUE;
    }

    placement.flags |= WPF_ASYNCWINDOWPLACEMENT;
    if (SetWindowPlacement(hwnd, &placement)) {
        context->moved++;
    } else {
        // Most often an elevated window, which we aren't allowed to touch
        context->failed++;
    }
    return TRUE;
}

bool GetRect(const Napi::Value& value, RECT* rect)
{
    if (!value.IsObject()) return false;
    const auto obj = value.As<Napi::Object>();
    for (const char* side : { "left", "top", "right", "bottom" }) {
        if (!obj.Get(side).IsNumber()) return false;
    }
    rect->left = obj.Get("left").As<Napi::Number>().Int32Value();
    rect->top = obj.Get("top").As<Napi::Number>().Int32Value();
    rect->right = obj.Get("right").As<Napi::Number>().Int32Value();
    rect->bottom = obj.Get("bottom").As<Napi::Number>().Int32Value();
    return rect->right > rect->left && rect->bottom > rect->top;
}

// Moves other apps' windows from one area of the desktop to another. Both areas
// are in physical pixels.
Napi::Object MoveWindowsBetweenAreas(const Napi::CallbackInfo& info)
{
    Napi::Object result = Napi::Object::New(info.Env());
    MoveWindowsContext context = {};
    if (info.Length() < 2 || !GetRect(info[0], &context.from) || !GetRect(info[1], &context.to)) {
        result.Set("moved", Napi::Number::New(info.Env(), 0));
        result.Set("failed", Napi::Number::New(info.Env(), 0));
        return result;
    }

    context.ownProcess = GetCurrentProcessId();
    EnumWindows(MoveWindowOffDisplay, reinterpret_cast<LPARAM>(&context));
    result.Set("moved", Napi::Number::New(info.Env(), context.moved));
    result.Set("failed", Napi::Number::New(info.Env(), context.failed));
    return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
    exports.Set("moveWindowsBetweenAreas", Napi::Function::New(env, MoveWindowsBetweenAreas));
    exports.Set("setWindowPos", Napi::Function::New(env, SetWindowPosition));
    exports.Set("getWindowPos", Napi::Function::New(env, GetWindowPosition));
    exports.Set("getClientPos", Napi::Function::New(env, GetClientPosition));
    exports.Set("getForegroundWindow", Napi::Function::New(env, GetForegroundWin));
    exports.Set("setForegroundWindow", Napi::Function::New(env, SetForegroundWin));
    exports.Set("getWindowLong", Napi::Function::New(env, GetWinLong));
    exports.Set("getWindowFullscreen", Napi::Function::New(env, GetWindowFullscreen));
    return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
