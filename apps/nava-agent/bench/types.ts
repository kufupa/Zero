export type Workflow = 'quote' | 'create' | 'amend' | 'cancel' | 'filing' | 'triage';

export type GoldField =
  | {path:string; expectation:'expected'; value:unknown; basis:string}
  | {path:string; expectation:'not_expected'; basis:string}
  | {path:string; expectation:'no_gold'; basis:string};

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
  source?:{
    input_cutoff?:string;
    [key:string]:unknown;
  };
  gold?:GoldField[];
  cassette?:RecordedToolPair[];
  recorded_calls?:RecordedToolPair[];
  tool_pairs?:RecordedToolPair[];
  quotes?:unknown;
  [key:string]:unknown;
};
