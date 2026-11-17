import { zeroNativeQuotePrice } from '../tools/quote/display.js';

type JsonObject = Record<string, unknown>;
type DisplayRow = {id:string; booking_id:string|null; label:string; native_path:string} & (
  {kind:'code'; code:string|null; meaning:string|null} |
  {kind:'availability'; status:'available'|'unavailable'|'restricted'|'unknown'; rooms_available:number|null} |
  {kind:'money'; amount:string|null; currency:string|null; unit:'night'|'stay'|'room'|'person'|null; date:string|null; basis:'native'|'calculated'; official:boolean} |
  {kind:'text'; value:string|null}
);
const object = (value:unknown):JsonObject => typeof value==='object' && value!==null && !Array.isArray(value) ? value as JsonObject : {};
const list = (value:unknown):unknown[] => Array.isArray(value) ? value : [];
const str = (value:unknown):string|null => typeof value==='string' ? value : null;

export function quoteDisplayRows(capture:unknown):DisplayRow[] {
  const rows:DisplayRow[]=[];
  const add=(row:DisplayRow)=>rows.push(row);
  for (const [i,groupValue] of list(object(capture).groups).entries()) {
    const group=object(groupValue);
    for (const [j,optionValue] of list(group.options).entries()) {
      const option=object(optionValue), base=`/groups/${i}/options/${j}`;
      const row=(suffix:string,label:string)=>({id:`${i}:${j}:${suffix}`,booking_id:null,label,native_path:`${base}/${suffix}`});
      for (const key of ['room','rate'] as const) {
        const value=object(option[key]);
        if (str(value.code)!==null || str(value.label)!==null) add({...row(key,key==='room'?'Room':'Rate'),kind:'code',code:str(value.code),meaning:str(value.label)});
      }
      const status=option.availability;
      add({...row('availability','Availability'),kind:'availability',status:status==='available'||status==='unavailable'||status==='restricted'?status:'unknown',rooms_available:null});
      const nights=list(option.nightly);
      const needsPriceReview=nights.some(value=>zeroNativeQuotePrice(object(object(value).price).amount));
      for (const [k,nightValue] of nights.entries()) {
        const night=object(nightValue), price=object(night.price), date=str(night.date);
        const zero=zeroNativeQuotePrice(price.amount);
        if(str(price.amount)!==null) add({...row(`nightly/${k}/price`,zero?'Nightly price needs staff review (HMS returned zero)':'Nightly price'),kind:'money',amount:zero?null:str(price.amount),currency:str(price.currency),unit:'night',date,basis:'native',official:!zero});
        if(Number.isInteger(night.inventory) && typeof night.inventory==='number' && night.inventory>=0) add({...row(`nightly/${k}/inventory`,date?`Rooms available ${date}`:'Rooms available'),kind:'availability',status:night.restricted===true||night.rateAvailable===false?'restricted':night.rateAvailable===true&&night.restricted===false&&night.inventory>0?'available':night.inventory===0?'unavailable':'unknown',rooms_available:night.inventory});
      }
      for (const key of ['perRoom','forQuantity'] as const) {
        const sum=object(object(option.calculated)[key]);
        if(!needsPriceReview && sum.official===false && str(sum.amount)!==null && !zeroNativeQuotePrice(sum.amount)) add({...row(`calculated/${key}`,'Displayed nightly sum (not HMS payable total)'),kind:'money',amount:str(sum.amount),currency:str(sum.currency),unit:key==='perRoom'?'room':'stay',date:null,basis:'calculated',official:false});
      }
      const meal=object(option.mealPlan);
      if(str(meal.code)!==null||str(meal.label)!==null) add({...row('mealPlan','Meal'),kind:'code',code:str(meal.code),meaning:str(meal.label)});
      else if(typeof option.mealPlan==='string') add({...row('mealPlan','Meal'),kind:'text',value:option.mealPlan});
    }
  }
  return rows;
}
