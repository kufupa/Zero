import type { Proposal, QuoteOption, QuoteSelection } from './wire';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item)) : [];
}

function barBreakfast(option: QuoteOption): boolean {
  if (option.rate_scope && option.rate_scope !== 'public') return false;
  const meal = typeof option.meal_plan === 'string' ? option.meal_plan : Object.values(object(option.meal_plan)).join(' ');
  return (option.rate.code.toUpperCase() === 'BAR' || /best available rate/i.test(option.rate.label ?? '')) && /breakfast|\bB\s*&\s*B\b/i.test(meal);
}

function roomMatches(option: QuoteOption, room: Record<string, unknown>): boolean {
  const required=object(room.required), preferred=object(room.preferred);
  const codes=[...strings(required.roomCodes),...strings(preferred.roomCodes)];
  const beds=[...strings(required.bedTypes),...strings(preferred.bedTypes)];
  const code=option.room.code.toLowerCase(), label=(option.room.label ?? '').toLowerCase();
  return codes.some(value=>value.toLowerCase()===code || value.toLowerCase()===label) ||
    beds.some(value=>label.includes(value.toLowerCase()) || code.includes(value.toLowerCase()));
}

function price(option: QuoteOption): number {
  return option.nightly.reduce((sum,night)=>sum+Math.round(Number(night.price.amount)*100),0);
}

export function defaultQuoteSelections(proposal: Proposal): QuoteSelection[] {
  const stage=proposal.stage;
  if (!stage?.quote_id || !stage.quote_options) return [];
  const action=proposal.actions.find(item=>item.type==='quote' && object(item.details).quote_id===stage.quote_id);
  const groups=object(action?.details).groups;
  if (!Array.isArray(groups)) return [];
  const selections: QuoteSelection[]=[];
  for (const rawGroup of groups) {
    const group=object(rawGroup);
    if (typeof group.group_id!=='string' || !Array.isArray(group.rooms)) return [];
    for (const rawRoom of group.rooms) {
      const room=object(rawRoom);
      if (typeof room.id!=='string') return [];
      const options=stage.quote_options.filter(option=>option.group_id===group.group_id && option.room_id===room.id);
      const matches=options.filter(option=>roomMatches(option,room));
      const breakfast=options.filter(barBreakfast);
      const matchingBreakfast=matches.filter(barBreakfast);
      const negotiated=options.filter(option=>option.rate_scope==='contextual' && option.match_status==='match');
      const matchingNegotiated=negotiated.filter(option=>roomMatches(option,room));
      const candidates=[matchingNegotiated,negotiated,matchingBreakfast,matches,breakfast,
        options.filter(option=>option.match_status==='match')].find(group=>group.length) ?? [];
      const selected=[...candidates].sort((a,b)=>price(a)-price(b) || a.option_index-b.option_index)[0];
      if (selected) selections.push({group_id:group.group_id,room_id:room.id,option_index:selected.option_index});
    }
  }
  return selections;
}
