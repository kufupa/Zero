import {expect,it} from 'vitest';
import {mapStaffActions,openReviewItems,projectQuoteReviewItems} from '../lib/quote-workflow/review-items';
import {readStaffActions} from '../lib/quote-workflow/staff-quote-bind';

it('projects separate source-bound voucher checks as staff reviews, not guest questions',()=>{
 const base={kind:'voucher_review',sourceKind:'message',sourceRef:'message:mail-1',messageId:'mail-1',sourceHash:'a'.repeat(64),blockingQuote:false,status:'open'};
 const actions=readStaffActions({runId:'latest-run',workItemId:'item-1',reviewSummary:{staffActions:[
  {...base,id:'voucher:first',runId:'earlier-run',handled:false,text:'Please check the attached hotel voucher.'},
  {...base,id:'voucher:second',handled:true,text:'Then verify the second hotel voucher.'},
  {...base,id:'voucher:foreign',sourceRef:'message:other',text:'Do not show a mismatched source.'},
 ]}});
 expect(actions).toHaveLength(2);
 expect(mapStaffActions(actions).map(item=>({id:item.id,kind:item.kind,blocking:item.blocking}))).toEqual([
  {id:'voucher:first',kind:'staff_review',blocking:false},
  {id:'voucher:second',kind:'staff_review',blocking:false},
 ]);
 const items=projectQuoteReviewItems(null,[],[],actions);
 expect(items).toMatchObject([
  {id:'voucher:first',runId:'earlier-run',workItemId:'item-1',handled:false},
  {id:'voucher:second',runId:'latest-run',workItemId:'item-1',handled:true},
 ]);
 expect(openReviewItems({reviewItems:items})).toEqual([items[0]]);
});
