type FolioRow={id:string;reservation_id:string|null;folio_type:string;balance:number|string|null;currency:string};
export function reservationFolioIndex(rows:readonly FolioRow[]){
  const index:Record<string,{id:string;count:number;balance:number|null;credit:number;currency:string|null;guest:boolean}>={};
  for(const folio of rows){
    if(!folio.reservation_id)continue;
    const current=index[folio.reservation_id]??{id:folio.id,count:0,balance:0,credit:0,currency:folio.currency,guest:false};
    const valid=folio.balance!==null&&String(folio.balance).trim()!==""&&Number.isFinite(Number(folio.balance));
    current.count++;
    if(!valid)current.balance=null;
    else{
      if(current.balance!==null)current.balance+=Math.max(0,Number(folio.balance));
      current.credit+=Math.max(0,-Number(folio.balance));
    }
    if(current.currency!==folio.currency)current.currency=null;
    if(folio.folio_type==="guest"){current.id=folio.id;current.guest=true;}
    index[folio.reservation_id]=current;
  }
  return index;
}
