export type Workflow = 'quote' | 'create' | 'amend' | 'cancel' | 'filing' | 'triage';

export type GoldField = {knowable?: boolean; aliases?: string[]; unobserved_in_twin?: boolean} & (
  | {path:string; expectation:'expected'; value:unknown; basis:string; tier?:string; hms_key?:string; before?:unknown; derivable?:string; priority?:string; source?:string}
  | {path:string; expectation:'not_expected'; basis:string; tier?:string; later_value?:unknown; hms_key?:string; priority?:string; source?:string}
  | {path:string; expectation:'no_gold'; basis:string; tier?:string; later_value?:unknown; hms_key?:string; priority?:string; source?:string}
  | {path:string; expectation:'diagnostic'; value?:unknown; basis:string; tier?:string; later_value?:unknown; hms_key?:string; priority?:string; source?:string});

export type TwinError = {
  code:string;
  message:string;
  retryable:boolean;
  outcome:'known'|'uncertain';
};

export type TwinEnvelope<T=unknown> =
  | {ok:true; data:T; error:null}
  | {ok:false; data:T|null; error:TwinError};

export type RecordedToolPair = {
  tool?:string;
  name?:string;
  input:unknown;
  result?:unknown;
  response?:unknown;
};

export type CaseCard = {
  case_id:string;
  workflow:Workflow;
  real_confirmation?:string|null;
  confirmation?:string|null;
  as_of?:string;
  property_code?:string;
  expected_targets?:string[];
  expected_action_count?:number;
  expected_disposition?:string;
  expected_dispositions?:string[];
  is_vcc_trap?:boolean;
  is_staff_reply_trap?:boolean;
  doc_kind?:string;
  source?:{
    input_cutoff?:string;
    [key:string]:unknown;
  };
  gold?:GoldField[];
  unscored_request_fields?:GoldField[];
  omitted?:Array<{path:string;reason:string}>;
  quotes?:unknown;
  [key:string]:unknown;
};
