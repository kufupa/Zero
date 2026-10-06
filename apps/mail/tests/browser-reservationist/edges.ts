import {useState} from 'react';
export const useSettings=()=>({data:{settings:{defaultEmailAlias:'staff@example.invalid'}}});
export const useThread=()=>({data:null});
export const useOptimisticActions=()=>({optimisticDeleteDraft:async()=>{}});
export const useTemplates=()=>({data:[],isLoading:false});
export const useQueryState=(key:string)=>useState<string|null>(key==='isComposeOpen'?'true':null);
