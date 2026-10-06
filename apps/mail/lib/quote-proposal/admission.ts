export type PaneProposalSelection={kind?:'native'|'imported_offer'|'approved_override';workflowRunId:string;messageId:string;threadId:string;revisionRef:string;factRefs:string[];totalMinor:number;currency:string;arrivalDate:string;departureDate:string;description:string};
export function canCreatePaneProposal(selection?:PaneProposalSelection|null):boolean {
 return Boolean(selection?.workflowRunId&&selection.messageId&&selection.revisionRef);
}
