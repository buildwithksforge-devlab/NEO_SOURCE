type SelectableFolio={id:string;status:string};
export function selectReservationFolio<T extends SelectableFolio>(folios:readonly T[],selectedId:string|null):T|undefined{
  if(selectedId){const chosen=folios.find(f=>f.id===selectedId);if(chosen)return chosen}
  // The query orders oldest -> newest. Keep history accessible, but default to live work.
  return [...folios].reverse().find(f=>['open','under-review','reopened'].includes(f.status))
    ?? [...folios].reverse().find(f=>!['void','voided'].includes(f.status));
}

export function linkedFolioBalance(folios:readonly {status:string;currency:string;balance:number}[],currency:string):number|null{
  const active=folios.filter(f=>!['void','voided'].includes(f.status));
  if(!folios.length)return null;
  if(!active.length)return 0;
  if(active.some(f=>f.currency!==currency||typeof f.balance!=='number'||!Number.isFinite(f.balance)))return null;
  const sum=active.reduce((total,f)=>total+f.balance,0);
  return Number.isFinite(sum)?Math.round(sum*100)/100:null;
}
