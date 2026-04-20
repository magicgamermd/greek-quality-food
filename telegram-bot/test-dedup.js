/**
 * Test suite for bot deduplication and single-response guarantees.
 * Run: node test-dedup.js
 */

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}`);
    failed++;
  }
}

// --- Simulate the dedup logic from bot.js ---

const _processedMessages = new Map();
const _userLocks = new Map();

function wouldProcess(messageId, userId, text) {
  // message_id dedup
  if (messageId) {
    if (_processedMessages.has(messageId)) return false;
    _processedMessages.set(messageId, Date.now());
  }

  // text dedup fallback
  const dedupeKey = `${userId}_${text}`;
  const now = Date.now();
  if (
    !messageId &&
    _processedMessages.has(dedupeKey) &&
    now - _processedMessages.get(dedupeKey) < 3000
  ) {
    return false;
  }
  if (!messageId) _processedMessages.set(dedupeKey, now);

  return true;
}

function wouldLock(userId) {
  if (_userLocks.has(userId)) return false;
  _userLocks.set(userId, true);
  return true;
}

function unlock(userId) {
  _userLocks.delete(userId);
}

// --- Tests ---

console.log("\n=== Test 1: Single response per text message ===");
{
  _processedMessages.clear();
  const first = wouldProcess(100, 123, "колко фритюрника имаме");
  const second = wouldProcess(100, 123, "колко фритюрника имаме");
  assert(first === true, "First message processes");
  assert(second === false, "Same message_id blocked");
}

console.log("\n=== Test 2: Single response per voice message ===");
{
  _processedMessages.clear();
  const first = wouldProcess(200, 123, "направи поръчка");
  const second = wouldProcess(200, 123, "направи поръчка");
  assert(first === true, "First voice transcript processes");
  assert(second === false, "Same message_id from voice blocked");
}

console.log("\n=== Test 3: Different messages process independently ===");
{
  _processedMessages.clear();
  const first = wouldProcess(300, 123, "фактура");
  const second = wouldProcess(301, 123, "товарителница");
  assert(first === true, "First message processes");
  assert(second === true, "Different message processes");
}

console.log("\n=== Test 4: Different users same text both process ===");
{
  _processedMessages.clear();
  const user1 = wouldProcess(400, 111, "здравей");
  const user2 = wouldProcess(401, 222, "здравей");
  assert(user1 === true, "User 1 processes");
  assert(user2 === true, "User 2 processes");
}

console.log("\n=== Test 5: Per-user lock prevents concurrent processing ===");
{
  _userLocks.clear();
  const first = wouldLock(123);
  const second = wouldLock(123);
  assert(first === true, "First lock acquired");
  assert(second === false, "Second lock rejected (concurrent)");
  unlock(123);
  const third = wouldLock(123);
  assert(third === true, "Lock acquired after release");
  unlock(123);
}

console.log("\n=== Test 6: Different users not blocked by lock ===");
{
  _userLocks.clear();
  const user1 = wouldLock(111);
  const user2 = wouldLock(222);
  assert(user1 === true, "User 1 locks");
  assert(user2 === true, "User 2 locks independently");
  unlock(111);
  unlock(222);
}

console.log("\n=== Test 7: Button debounce simulation ===");
{
  // Simulates global._invoiceDebounce pattern
  const debounce = {};
  const key = "inv_123_42";

  const first = !debounce[key];
  debounce[key] = true;

  const second = !debounce[key];

  assert(first === true, "First button click processes");
  assert(second === false, "Double-click blocked");

  delete debounce[key];
  const third = !debounce[key];
  assert(third === true, "After timeout, button works again");
}

console.log("\n=== Test 8: Fallback text dedup (no message_id) ===");
{
  _processedMessages.clear();
  const first = wouldProcess(null, 123, "test message");
  const second = wouldProcess(null, 123, "test message");
  assert(first === true, "First processes");
  assert(second === false, "Duplicate text within 3s blocked");
}

console.log("\n=== Test 9: Keyword exclusivity (return early) ===");
{
  // Verify keyword patterns are mutually exclusive
  const text1 = "фактура за поръчка 5";
  const text2 = "товарителница";
  const text3 = "справка за наличности";

  const matchesFaktura = /фактур/i.test(text1);
  const matchesTovar = /товарителниц|tovaritelni[ct]/i.test(text1);

  assert(matchesFaktura === true, "'фактура' matches invoice pattern");
  assert(matchesTovar === false, "'фактура' does NOT match waybill pattern");

  const t2Faktura = /фактур/i.test(text2);
  const t2Tovar = /товарителниц|tovaritelni[ct]/i.test(text2);
  assert(t2Faktura === false, "'товарителница' does NOT match invoice");
  assert(t2Tovar === true, "'товарителница' matches waybill pattern");

  const t3Inventory = /(?:справка|наличност|inventory)/i.test(text3);
  assert(t3Inventory === true, "'справка' matches inventory pattern");
}

// --- Summary ---
console.log(`\n${"=".repeat(40)}`);
console.log(
  `Results: ${passed} passed, ${failed} failed out of ${passed + failed}`,
);
if (failed > 0) process.exit(1);
console.log("All tests passed!\n");
