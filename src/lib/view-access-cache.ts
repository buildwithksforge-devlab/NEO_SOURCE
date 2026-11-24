/** Drop answers from a superseded authority contract before publishing new grants. */
export function clearChangedAccessViews(cache:{cancelQueries:()=>unknown;clear:()=>void},previous:string|null,next:string|null):boolean {
 if(previous === null || previous === next)return false;
 void cache.cancelQueries();
 cache.clear();
 return true;
}
