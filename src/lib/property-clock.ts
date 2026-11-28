/** Convert a property wall time to an instant without using the computer clock zone. */
export function propertyDateTimeToIso(value: string, timeZone: string | null): string | null {
  if (!value.trim()) return null;
  if (!timeZone) throw Error('Choose a property and wait for its timezone before saving a time.');
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw Error('Enter a valid local date and time.');
  const [year,month,day,hour,minute,second]=match.slice(1).map(v=>Number(v??0)) as [number,number,number,number,number,number];
  const wall=Date.UTC(year,month-1,day,hour,minute,second);
  if (hour>23||minute>59||second>59||new Date(wall).toISOString().slice(0,10)!==value.slice(0,10)) throw Error('Enter a valid local date and time.');
  const formatter=clockFormatter(timeZone);
  const wallAt=(instant:number)=>{
    const parts=formatter.formatToParts(instant);
    const get=(type:string)=>Number(parts.find(p=>p.type===type)?.value);
    return Date.UTC(get('year'),get('month')-1,get('day'),get('hour'),get('minute'),get('second'));
  };
  const offsets=new Set<number>();
  for(let h=-36;h<=36;h+=6){const probe=wall+h*3600000;offsets.add(wallAt(probe)-probe)}
  const matches=[...offsets].map(offset=>wall-offset).filter(candidate=>wallAt(candidate)===wall);
  if(matches.length!==1)throw Error('This property time is skipped or repeated by a clock change. Choose an unambiguous time.');
  return new Date(matches[0]!).toISOString();
}

function clockFormatter(timeZone:string){
  try{return new Intl.DateTimeFormat('en-GB',{timeZone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'})}
  catch{throw Error('The property timezone is invalid. Correct its regional configuration.')}
}

export function propertyDateTimeInput(value:unknown,timeZone:string):string{
  if(value===null||value===undefined||value==='')return '';
  const instant=new Date(String(value));
  if(!Number.isFinite(instant.getTime()))throw Error('The saved date and time is invalid.');
  const parts=clockFormatter(timeZone).formatToParts(instant);
  const get=(type:string)=>parts.find(p=>p.type===type)?.value??'';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export function propertyTimeZone(branches:readonly {id:string;organization_id:string;timezone?:string|null;active?:boolean}[],branchId:string|null,organizationId:string|null,organizationZone:string):string|null{
  const branch=branches.find(b=>b.id===branchId&&b.organization_id===organizationId&&b.active!==false);
  if(!branch)return null;
  const zone=branch.timezone||organizationZone||'Africa/Nairobi';
  clockFormatter(zone);
  return zone;
}
