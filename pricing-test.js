
'use strict';

const assert = require('node:assert/strict');
const Pricing = require('./pricing.js');

// 予約日を固定して、実行日による結果の変化を防ぐ
const bookingDate = '2026-10-27';

const A = (adults, child11 = 0, child6 = 0, child3 = 0) => ({
  adults, child11, child6, child3
});

const cases = [
  {
    name: '通常期・平日・大人4名',
    checkin: '2026-11-17',
    checkout: '2026-11-19',
    counts: A(4),
    expected: {
      lodgingSubtotal: 40000,
      totalDiscount: 0,
      accommodationTax: 0,
      finalTotal: 48000
    }
  },
  {
    name: '週末割増・大人4名',
    checkin: '2026-11-20',
    checkout: '2026-11-22',
    counts: A(4),
    expected: {
      lodgingSubtotal: 44000,
      totalDiscount: 0,
      accommodationTax: 0,
      finalTotal: 52000
    }
  },
  {
    name: '大人7名・追加人数半額',
    checkin: '2026-11-17',
    checkout: '2026-11-19',
    counts: A(7),
    expected: {
      lodgingSubtotal: 65000,
      totalDiscount: 0,
      accommodationTax: 0,
      finalTotal: 73000
    }
  },
  {
    name: '大人2名＋11歳以下1名＋6歳以下1名',
    checkin: '2026-11-17',
    checkout: '2026-11-19',
    counts: A(2, 1, 1),
    expected: {
      lodgingSubtotal: 40000,
      totalDiscount: 0,
      accommodationTax: 0,
      finalTotal: 48000
    }
  },
  {
    name: '3泊以上・連泊割引10%',
    checkin: '2026-11-17',
    checkout: '2026-11-20',
    counts: A(4),
    expected: {
      lodgingSubtotal: 60000,
      totalDiscount: 6000,
      accommodationTax: 0,
      finalTotal: 62000
    }
  },
  {
    name: '早期予約割引10%＋宿泊税',
    checkin: '2027-02-01',
    checkout: '2027-02-03',
    counts: A(4),
    expected: {
      lodgingSubtotal: 32000,
      totalDiscount: 3200,
      accommodationTax: 640,
      finalTotal: 37440
    }
  },
  {
    name: '直前割引20%＋宿泊税',
    checkin: '2027-02-01',
    checkout: '2027-02-03',
    bookingDate: '2027-01-20',
    counts: A(4),
    expected: {
      lodgingSubtotal: 32000,
      totalDiscount: 6400,
      accommodationTax: 480,
      finalTotal: 34080
    }
  },
  {
    name: '宿泊税開始日をまたぐ2泊',
    checkin: '2027-01-31',
    checkout: '2027-02-02',
    counts: A(4),
    expected: {
    lodgingSubtotal: 32000,
    totalDiscount: 3200,
    accommodationTax: 320,
    finalTotal: 37120
  }  
  },
  {
    name: '年末年始・特別料金',
    checkin: '2026-12-30',
    checkout: '2027-01-01',
    counts: A(4),
    expected: {
      lodgingSubtotal: 60000,
      totalDiscount: 6000,
      accommodationTax: 0,
      finalTotal: 62000
    }
  }
];

let passed = 0;
let failed = 0;

for (const test of cases) {
  try {
    const result = Pricing.quote({
      checkin: test.checkin,
      checkout: test.checkout,
      counts: test.counts,
      bookingDate: test.bookingDate || bookingDate
    });

    for (const [key, expectedValue] of Object.entries(test.expected)) {
      assert.equal(
        result[key],
        expectedValue,
        `${key}: expected ${expectedValue}, got ${result[key]}`
      );
    }

    console.log(`PASS  ${test.name}  ¥${result.finalTotal.toLocaleString('ja-JP')}`);
    passed++;
  } catch (error) {
    console.error(`FAIL  ${test.name}`);
    console.error(`      ${error.message}`);
    failed++;
  }
}

console.log('\n------------------------------');
console.log(`結果: ${passed} PASS / ${failed} FAIL`);

if (failed > 0) process.exitCode = 1;
