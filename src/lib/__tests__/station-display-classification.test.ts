import {describe,it,expect} from 'vitest';
import {stationDepartment,displayStations,selectedDisplayStation} from '@/lib/production-displays';
describe('configured production display classification',()=>{
 it.each(['coffee','pastry','bar','kitchen'] as const)('explicit %s is not overridden by conflicting label text',type=>{expect(stationDepartment({id:'s',name:'Coffee Pastry Kitchen Bar',station_type:type})).toBe(type)});
 it.each(['service',' Service ','SERVICE'])('service type %s never enters a production display',type=>{const station={id:'s',name:'Coffee Kitchen Counter',station_type:type};expect(stationDepartment(station)).toBeNull();for(const view of ['kitchen','bar','coffee','pastry','overview'] as const)expect(displayStations([station],view)).toEqual([])});
 it.each(['Larder','Cold Larder','Grill','GRILL_STATION','Hot Kitchen'])('legacy production subdivision %s stays on kitchen',name=>{expect(stationDepartment({id:'s',name,station_type:'production'})).toBe('kitchen')});
 it.each([' COFFEE ','Pastry',' BAR ','Kitchen'])('normalizes explicit type %s',type=>{expect(stationDepartment({id:'s',name:'Unrelated',station_type:type})).toBe(type.trim().toLowerCase())});
 it('retains the installed beverage-type Coffee Station and bar split',()=>{const coffee={id:'c',name:'Coffee Station',station_type:'beverage'},bar={id:'b',name:'Main Bar',station_type:'beverage'};expect(displayStations([coffee,bar],'coffee')).toEqual([coffee]);expect(displayStations([coffee,bar],'bar')).toEqual([bar])});
 it('recognizes underscore-delimited configured station codes',()=>{expect(stationDepartment({id:'s',name:'Counter One',code:'COFFEE_STATION',station_type:'production'})).toBe('coffee')});
 it('does not invent a kitchen mapping for an unknown custom production station',()=>{const station={id:'s',name:'Custom One',station_type:'production'};expect(stationDepartment(station)).toBeNull();expect(displayStations([station],'overview')).toEqual([station]);expect(displayStations([station],'kitchen')).toEqual([])});
 it('does not expand the supplied scoped station list for a bookmark',()=>{expect(selectedDisplayStation([{id:'mine',name:'Mine'}],'other')).toBeUndefined()});
});
