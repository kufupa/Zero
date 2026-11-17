type JsonObject = Record<string, unknown>;
export type DisplayRow = {id:string; booking_id:string|null; label:string; native_path:string; quote_id:string; group_id:string} & (
  {kind:'code'; code:string|null; meaning:string|null} |
  {kind:'availability'; status:'available'|'unavailable'|'restricted'|'unknown'; rooms_available:number|null} |
  {kind:'money'; amount:string|null; currency:string|null; unit:'night'|'stay'|'room'|'person'|null; date:string|null; basis:'native'|'calculated'; official:boolean} |
  {kind:'text'; value:string|null}
);
const object = (value:unknown):JsonObject => typeof value==='object' && value!==null && !Array.isArray(value) ? value as JsonObject : {};
const list = (value:unknown):unknown[] => Array.isArray(value) ? value : [];
const str = (value:unknown):string|null => typeof value==='string' ? value : null;
export const zeroNativeQuotePrice = (amount:unknown):boolean => typeof amount==='string' && /^[+-]?0+(?:\.0+)?$/.test(amount.trim());

/** Paths are relative to the returned aggregate, not to a detached option. */
export function quoteDisplayRows(capture:unknown, searchIndex:number, quoteId:string, identities:({group_id:string; room_id:string}|undefined)[]):DisplayRow[] {
  const rows:DisplayRow[]=[];
  for (const [i,groupValue] of list(object(capture).groups).entries()) {
    const group=object(groupValue), identity=identities[i];
    if (!identity) continue;
    if (!list(group.options).length) rows.push({id:`${searchIndex}:${i}:availability`,booking_id:identity.room_id,quote_id:quoteId,group_id:identity.group_id,label:'Availability',native_path:`/searches/${searchIndex}/native_result/groups/${i}/outcome`,kind:'availability',status:group.outcome==='unavailable'?'unavailable':'unknown',rooms_available:null});
    for (const [j,optionValue] of list(group.options).entries()) {
      const option=object(optionValue), base=`/searches/${searchIndex}/native_result/groups/${i}/options/${j}`;
      const row=(suffix:string,label:string)=>({id:`${searchIndex}:${i}:${j}:${suffix}`,booking_id:identity.room_id,quote_id:quoteId,group_id:identity.group_id,label,native_path:`${base}/${suffix}`});
      for (const key of ['room','rate'] as const) {
        const value=object(option[key]);
        if (str(value.code)!==null || str(value.label)!==null) rows.push({...row(key,key==='room'?'Room':'Rate'),kind:'code',code:str(value.code),meaning:str(value.label)});
      }
      const status=option.availability;
      rows.push({...row('availability','Availability'),kind:'availability',status:status==='available'||status==='unavailable'||status==='restricted'?status:'unknown',rooms_available:null});
      const nights=list(option.nightly);
      const needsPriceReview=nights.some(value=>zeroNativeQuotePrice(object(object(value).price).amount));
      for (const [k,nightValue] of nights.entries()) {
        const night=object(nightValue), price=object(night.price), date=str(night.date);
        const zero=zeroNativeQuotePrice(price.amount);
        if(str(price.amount)!==null) rows.push({...row(`nightly/${k}/price`,zero?'Nightly price needs staff review (HMS returned zero)':'Nightly price'),kind:'money',amount:zero?null:str(price.amount),currency:str(price.currency),unit:'night',date,basis:'native',official:!zero});
        if(Number.isInteger(night.inventory) && typeof night.inventory==='number' && night.inventory>=0) rows.push({...row(`nightly/${k}/inventory`,date?`Rooms available ${date}`:'Rooms available'),kind:'availability',status:night.restricted===true||night.rateAvailable===false?'restricted':night.rateAvailable===true&&night.restricted===false&&night.inventory>0?'available':night.inventory===0?'unavailable':'unknown',rooms_available:night.inventory});
      }
      for (const key of ['perRoom','forQuantity'] as const) {
        const sum=object(object(option.calculated)[key]);
        if(!needsPriceReview && sum.official===false && str(sum.amount)!==null && !zeroNativeQuotePrice(sum.amount)) rows.push({...row(`calculated/${key}`,'Displayed nightly sum (not HMS payable total)'),kind:'money',amount:str(sum.amount),currency:str(sum.currency),unit:key==='perRoom'?'room':'stay',date:null,basis:'calculated',official:false});
      }
      const meal=object(option.mealPlan);
      if(str(meal.code)!==null||str(meal.label)!==null) rows.push({...row('mealPlan','Meal'),kind:'code',code:str(meal.code),meaning:str(meal.label)});
      else if(typeof option.mealPlan==='string') rows.push({...row('mealPlan','Meal'),kind:'text',value:option.mealPlan});
    }
  }
  return rows;
}
