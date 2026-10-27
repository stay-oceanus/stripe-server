/* Cottage SERAGAKI pricing core — draft v1
 * Shared in browser: <script src="pricing.js"></script>
 * Shared in Node: const Pricing = require('./pricing.js')
 * Dates are YYYY-MM-DD (Japan local calendar dates).
 * Includes accommodation tax.
 * Do not deploy until parity tests pass.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SeragakiPricing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const seasonalPricingMap = {
    normal: { min: 20000, perAdult: 5000 },
    summer: { min: 24000, perAdult: 6000 },
    winter: { min: 16000, perAdult: 4000 }
  };
  const peakPricingMap = {
  // 通常期ベース
  gwShoulder:   { mode: "multiplier", minMultiplier: 1.15, perAdultMultiplier: 1.15 },
  gwPeak:       { mode: "multiplier", minMultiplier: 1.25, perAdultMultiplier: 1.25 },
  swPeak:       { mode: "multiplier", minMultiplier: 1.32, perAdultMultiplier: 1.32 },

  // 夏期ベース（夏通常120%に対して最終136% / 144%にしたい）
  obonShoulder: { mode: "multiplier", minMultiplier: 1.13, perAdultMultiplier: 1.13 },
  obonPeak:     { mode: "multiplier", minMultiplier: 1.20, perAdultMultiplier: 1.20 },

  // 年末年始だけ固定
  yearEnd:      { mode: "fixed", min: 26000, perAdult: 6500 },
  newYearPeak:  { mode: "fixed", min: 30000, perAdult: 7500 }
};
  const nationalHolidaySet = new Set([
  "2025-01-01","2025-01-13","2025-02-11","2025-02-23","2025-02-24","2025-03-20",
  "2025-04-29","2025-05-03","2025-05-04","2025-05-05","2025-05-06","2025-07-21",
  "2025-08-11","2025-09-15","2025-09-23","2025-10-13","2025-11-03","2025-11-23","2025-11-24",

  "2026-01-01","2026-01-12","2026-02-11","2026-02-23","2026-03-20","2026-04-29",
  "2026-05-03","2026-05-04","2026-05-05","2026-05-06","2026-07-20","2026-08-11",
  "2026-09-21","2026-09-22","2026-09-23","2026-10-12","2026-11-03","2026-11-23",

  "2027-01-01","2027-01-11","2027-02-11","2027-02-23","2027-03-21","2027-03-22",
  "2027-04-29","2027-05-03","2027-05-04","2027-05-05","2027-07-19","2027-08-11",
  "2027-09-20","2027-09-23","2027-10-11","2027-11-03","2027-11-23",

  "2028-01-01","2028-01-10","2028-02-11","2028-02-23","2028-03-20","2028-04-29",
  "2028-05-03","2028-05-04","2028-05-05","2028-07-17","2028-08-11",
  "2028-09-18","2028-09-22","2028-10-09","2028-11-03","2028-11-23"
]);
  const specialPeakDates = Object.create(null);
  function utcDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Invalid date: '+s);
    const d = new Date(s+'T00:00:00Z');
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0,10)!==s) throw new Error('Invalid date: '+s);
    return d;
  }
  function dateKey(d) {
    if (typeof d === 'string') return utcDate(d).toISOString().slice(0,10);
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new Error('Invalid date');
    // Dates supplied by a browser should represent a local calendar date.
    return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
  }
  function plusDays(s,n) { const d=utcDate(s); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
  function diffDays(a,b) { return Math.round((utcDate(a)-utcDate(b))/86400000); }
  function addRange(a,b,rule) {
    for(let day=a;day<=b;day=plusDays(day,1)) specialPeakDates[day]=peakPricingMap[rule];
  }
  addRange('2025-12-27','2025-12-29','yearEnd');
  addRange('2025-12-30','2026-01-01','newYearPeak');
  addRange('2026-01-02','2026-01-03','yearEnd');
  addRange('2026-04-29','2026-04-29','gwShoulder');
  addRange('2026-05-01','2026-05-01','gwShoulder');
  addRange('2026-05-02','2026-05-05','gwPeak');
  addRange('2026-05-06','2026-05-06','gwShoulder');
  addRange('2026-08-08','2026-08-10','obonShoulder');
  addRange('2026-08-11','2026-08-16','obonPeak');
  addRange('2026-09-19','2026-09-23','swPeak');
  addRange('2026-12-26','2026-12-29','yearEnd');
  addRange('2026-12-30','2027-01-02','newYearPeak');
  addRange('2027-01-03','2027-01-03','yearEnd');
  addRange('2027-04-29','2027-04-30','gwShoulder');
  addRange('2027-05-01','2027-05-05','gwPeak');
  addRange('2027-08-07','2027-08-10','obonShoulder');
  addRange('2027-08-11','2027-08-15','obonPeak');
  addRange('2027-09-18','2027-09-20','swPeak');
  addRange('2027-12-27','2027-12-29','yearEnd');
  addRange('2027-12-30','2028-01-02','newYearPeak');
  addRange('2028-01-03','2028-01-03','yearEnd');
  addRange('2028-04-29','2028-04-30','gwShoulder');
  addRange('2028-05-01','2028-05-05','gwPeak');
  addRange('2028-05-06','2028-05-07','gwShoulder');
  addRange('2028-08-10','2028-08-10','obonShoulder');
  addRange('2028-08-11','2028-08-16','obonPeak');
  addRange('2028-09-16','2028-09-18','swPeak');

  function season(day) {
    const month=Number(day.slice(5,7));
    return [6,7,8,9].includes(month)?'summer':([12,1,2].includes(month)?'winter':'normal');
  }
  function rateFor(day) {
    const base=seasonalPricingMap[season(day)];
    const rule=specialPeakDates[day];
    if(!rule) return base;
    if(rule.mode==='fixed') return {min:rule.min,perAdult:rule.perAdult};
    return {min:Math.round(base.min*rule.minMultiplier),perAdult:Math.round(base.perAdult*rule.perAdultMultiplier)};
  }
  function weekendOrEve(day) {
    const dow=utcDate(day).getUTCDay();
    return dow===5 || dow===6 || nationalHolidaySet.has(plusDays(day,1));
  }
  function validatedCounts(counts) {
    const result={};
    for(const key of ['adults','child11','child6','child3']) {
      const n=Number(counts?.[key]??0);
      if(!Number.isInteger(n)||n<0) throw new Error('Invalid guest count: '+key);
      result[key]=n;
    }
    if(Object.values(result).reduce((a,b)=>a+b,0)>10 || Object.values(result).every(v=>v===0))
      throw new Error('Guest count must be 1-10');
    return result;
  }
  function dailyBreakdown(dayInput,countsInput) {
    const day=dateKey(dayInput), counts=validatedCounts(countsInput);
    const {adults,child11,child6,child3}=counts;
    const rate=rateFor(day), adultUnit=rate.perAdult;
    const extraAdultUnit=Math.round(adultUnit*.5);
    const child11Unit=Math.round(adultUnit*.5), child6Unit=Math.round(adultUnit*.25);
    const baseAdults=Math.min(adults,Math.max(6-child11-child6,0));
    const extraAdults=Math.max(adults-baseAdults,0);
    let normalAdultTotal=baseAdults*adultUnit;
    let extraAdultTotal=extraAdults*extraAdultUnit;
    let adultTotal=normalAdultTotal+extraAdultTotal;
    let child11Total=child11*child11Unit, child6Total=child6*child6Unit;
    let nightlyAfterChild=adultTotal+child11Total+child6Total;
    const isMinApplied=nightlyAfterChild<rate.min;
    nightlyAfterChild=Math.max(nightlyAfterChild,rate.min);
    if(!specialPeakDates[day] && weekendOrEve(day)) {
      nightlyAfterChild=Math.round(nightlyAfterChild*1.1);
      normalAdultTotal=Math.round(normalAdultTotal*1.1);
      extraAdultTotal=Math.round(extraAdultTotal*1.1);
      adultTotal=Math.round(adultTotal*1.1);
      child11Total=Math.round(child11Total*1.1);
      child6Total=Math.round(child6Total*1.1);
    }
    return {
      ymd:day, weekday:['日','月','火','水','木','金','土'][utcDate(day).getUTCDay()],
      nightlyAfterChild,isMinApplied,
      breakdown:{
        adults:{count:adults,total:adultTotal,unit:adultUnit,baseCount:baseAdults,
          extraCount:extraAdults,extraUnit:extraAdultUnit,normalTotal:normalAdultTotal,extraTotal:extraAdultTotal},
        child11:{count:child11,total:child11Total,unit:child11Unit},
        child6:{count:child6,total:child6Total,unit:child6Unit},
        child3:{count:child3,total:0,unit:0}
      }
    };
  }

  // ===== 宿泊税 =====
  const ACCOMMODATION_TAX_CONFIG = Object.freeze({
    startDate: '2027-02-01',
    rate: 0.02,
    maxTaxPerPersonPerNight: 2000,
    taxableUnit: 1000,
    consumptionTaxRate: 0.10
  });

  function calculateAccommodationTax({
    checkin,
    nights,
    guestCount,
    totalAmount
  }) {
    const result = {
      totalTax: 0,
      nights: [],
      taxExcludedTotal: 0,
      perPersonPerNight: 0,
      taxableBasePerPersonPerNight: 0,
      taxPerPersonPerNight: 0
    };

    const stayNights = Math.max(0, Number(nights) || 0);
    const guests = Math.max(0, Number(guestCount) || 0);
    const includedTotal = Math.max(0, Number(totalAmount) || 0);

    if (!checkin || stayNights <= 0 || guests <= 0 || includedTotal <= 0) {
      return result;
    }

    const taxExcludedTotal = Math.floor(
      includedTotal / (1 + ACCOMMODATION_TAX_CONFIG.consumptionTaxRate)
    );

    const perPersonPerNight =
      taxExcludedTotal / (guests * stayNights);

    const taxableBasePerPersonPerNight =
      Math.floor(perPersonPerNight / ACCOMMODATION_TAX_CONFIG.taxableUnit) *
      ACCOMMODATION_TAX_CONFIG.taxableUnit;

    const taxPerPersonPerNight = Math.min(
      Math.floor(taxableBasePerPersonPerNight * ACCOMMODATION_TAX_CONFIG.rate),
      ACCOMMODATION_TAX_CONFIG.maxTaxPerPersonPerNight
    );

    result.taxExcludedTotal = taxExcludedTotal;
    result.perPersonPerNight = perPersonPerNight;
    result.taxableBasePerPersonPerNight = taxableBasePerPersonPerNight;
    result.taxPerPersonPerNight = taxPerPersonPerNight;

    const firstNight = dateKey(checkin);

    for (let i = 0; i < stayNights; i++) {
      const stayDate = plusDays(firstNight, i);
      const applicable = stayDate >= ACCOMMODATION_TAX_CONFIG.startDate;
      const nightTax = applicable ? taxPerPersonPerNight * guests : 0;

      result.totalTax += nightTax;
      result.nights.push({
        date: stayDate,
        tax: nightTax,
        taxPerPerson: applicable ? taxPerPersonPerNight : 0
      });
    }

    return result;
  }

  function quote({checkin,checkout,counts,bookingDate}) {
    const start=dateKey(checkin),end=dateKey(checkout),today=dateKey(bookingDate);
    const nights=diffDays(end,start);
    if(nights<1||nights>180) throw new Error('Invalid stay length');
    if(diffDays(start,today)<0) throw new Error('Check-in is in the past');
    validatedCounts(counts);
    const daily=Array.from({length:nights},(_,i)=>dailyBreakdown(plusDays(start,i),counts));
    const lodgingSubtotal=daily.reduce((s,d)=>s+d.nightlyAfterChild,0);
    const discounts=[];
    if(diffDays(start,today)>=60) discounts.push({label:'早期予約割引(-10%)',amount:Math.round(lodgingSubtotal*.1),rate:10});
    if(nights>=3) discounts.push({label:'連泊割引(-10%)',amount:Math.round(lodgingSubtotal*.1),rate:10});
    const eligible=daily.filter(d=>diffDays(d.ymd,today)<=14);
    if(eligible.length) discounts.push({label:'直前割引(-20%)',
      amount:eligible.reduce((s,d)=>s+Math.round(d.nightlyAfterChild*.2),0),rate:20,nights:eligible.length});
    const totalDiscount=discounts.reduce((s,d)=>s+d.amount,0);
    const cleaningFee=8000;
    const lodgingAfterDiscount=Math.max(0,lodgingSubtotal-totalDiscount);
    
    const totalBeforeTax = lodgingAfterDiscount + cleaningFee;

    const guestCount = Object.values(validatedCounts(counts))
      .reduce((sum, count) => sum + count, 0);

    const accommodationTaxResult = calculateAccommodationTax({
      checkin: start,
      nights,
      guestCount,
      totalAmount: totalBeforeTax
    });

    const accommodationTax = accommodationTaxResult.totalTax;
    const finalTotal = totalBeforeTax + accommodationTax;

    return {
      checkin: start,
      checkout: end,
      nights,
      daily,
      lodgingSubtotal,
      discounts,
      totalDiscount,
      lodgingAfterDiscount,
      cleaningFee,
      totalBeforeTax,
      accommodationTax,
      accommodationTaxResult,
      finalTotal
    };
  }

  return Object.freeze({
    dateKey,
    diffDays,
    rateFor,
    dailyBreakdown,
    calculateAccommodationTax,
    quote
  });
});

