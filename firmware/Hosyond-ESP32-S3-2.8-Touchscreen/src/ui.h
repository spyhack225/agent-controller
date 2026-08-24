#pragma once

// The touch UI.
//
// Split out of main.cpp because main.cpp is the board — boot, pins, radios, buttons — and this is
// the product. The division is worth stating: nothing in here knows a pin number, and nothing in
// main.cpp knows what a thread is.
//
// The screens exist because a controller that can only say "Ready" is an ornament. In order of how
// a person uses one: HOME (what is happening), THREADS (where work goes), SEND (make a request),
// RESPONSE (read the answer), APPROVALS (unblock a command policy parked), and — above THREADS —
// ENVIRONMENTS and PROJECTS, which are the two levels of "where" the gateway grew device-facing
// endpoints for.
//
// There is no tab bar. Navigation is a status drawer pulled down from the header and a contextual
// action bar that exists only while there is something to press; the bottom of the screen belongs
// to the content the rest of the time.

#include <Arduino.h>

#include <DeviceStore.h>
#include <GatewayClient.h>
#include <Provisioning.h>

#include "touch.h"

// Must be called after displayBegin() and displayBeginCanvases(). Returns false when the orbs could
// not be allocated, in which case the UI still runs — it simply has no animation.
bool uiBegin(GatewayClient& gateway, Provisioning& provisioning, DeviceStore& store);

// One touch event, from touchPoll(). Every gateway call this triggers blocks for up to the client's
// timeout, so each one paints its pending state before making it.
void uiHandleTouch(const TouchEvent& event);

// Call every loop pass. Owns the frame budget: it paces itself internally and returns immediately
// when the next frame is not yet due.
void uiTick();

// Sleeps until the next frame is actually due, rather than having the caller spin on delay(1).
void uiSleepUntilNextFrame();
