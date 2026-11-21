using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;

namespace NeoPrintAgent {
 internal static class PrinterDiscovery {
  internal static string Classify(string port, bool network, ISet<string> bluetoothPorts) {
   if(Regex.IsMatch(port??"","BTH|Bluetooth",RegexOptions.IgnoreCase)||bluetoothPorts.Contains((port??"").TrimEnd(':')))return "bluetooth";
   if(Regex.IsMatch(port??"","^(USB|DOT4)",RegexOptions.IgnoreCase))return "usb";
   if(network||Regex.IsMatch(port??"","^(IP_|WSD|\\\\)",RegexOptions.IgnoreCase))return "network";
   return "windows";
  }
  internal static Dictionary<string,object> Find(string kind) {
   if(!new[]{"windows","usb","bluetooth","network"}.Contains(kind))throw new ArgumentException("Unknown printer search type");
   var printers=new List<object>();var notes=new List<string>();var bluetoothPorts=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
   try { using(var query=new ManagementObjectSearcher("SELECT DeviceID,PNPDeviceID FROM Win32_SerialPort"))using(var rows=query.Get())foreach(ManagementObject row in rows)using(row) {
    if(Regex.IsMatch(Program.Text(row["PNPDeviceID"]),"^BTH",RegexOptions.IgnoreCase))bluetoothPorts.Add(Program.Text(row["DeviceID"]).TrimEnd(':'));
   }}catch(Exception e){notes.Add("Bluetooth serial-port inventory unavailable: "+e.Message);}
   var networkPorts=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
   try {using(var query=new ManagementObjectSearcher("SELECT Name FROM Win32_TCPIPPrinterPort"))using(var rows=query.Get())foreach(ManagementObject row in rows)using(row)networkPorts.Add(Program.Text(row["Name"]));}catch(Exception e){notes.Add("TCP/IP port inventory unavailable: "+e.Message);}
   try {using(var query=new ManagementObjectSearcher("SELECT Name,PortName,DriverName,Network FROM Win32_Printer"))using(var rows=query.Get())foreach(ManagementObject row in rows)using(row) {
    var name=Program.Text(row["Name"]);var port=Program.Text(row["PortName"]);if(PrinterTransport.IsVirtual(name)||PrinterTransport.IsVirtual(Program.Text(row["DriverName"])))continue;
    var transport=Classify(port,networkPorts.Contains(port)||object.Equals(row["Network"],true),bluetoothPorts);
    if(kind!="windows"&&kind!=transport)continue;
    printers.Add(new Dictionary<string,object>{{"name",name},{"address",name},{"connection_type","windows"},{"transport",transport},{"source","Windows installed queue"},{"driver",Program.Text(row["DriverName"])},{"note","Installed driver queue detected; verify paper size and a labelled test print."}});
    if(printers.Count>=100)break;
   }}catch(Exception e){notes.Add("Windows printer inventory unavailable: "+e.Message);}
   if(kind=="network")printers.AddRange(Network(notes));
   notes.Add("USB/Bluetooth printers must be installed in Windows. This search does not pair devices or install drivers.");
   if(kind=="network")notes.Add("Network search includes installed Ethernet/Wi-Fi queues and local mDNS advertisements. A non-advertising printer can be added by its known IP address or Windows queue.");
   if(printers.Count==0)notes.Add("No matching physical printer was detected. Check the device connection and installed driver.");
   return new Dictionary<string,object>{{"printers",printers.Take(100).ToArray()},{"notes",notes.ToArray()}};
  }
  internal sealed class Record { internal string Name,Target,Address;internal int Type,Port; }
  static int U16(byte[] data,int offset){if(offset<0||offset+2>data.Length)throw new InvalidDataException("Truncated DNS value");return (data[offset]<<8)|data[offset+1];}
  static string Name(byte[] data,ref int offset,int depth=0) {
   if(depth>16)throw new InvalidDataException("DNS pointer cycle");var labels=new List<string>();
   for(int steps=0;steps<128;steps++){
    if(offset>=data.Length)throw new InvalidDataException("Truncated DNS name");int length=data[offset++];if(length==0)return string.Join(".",labels).ToLowerInvariant();
    if((length&192)==192){if(offset>=data.Length)throw new InvalidDataException("Truncated DNS pointer");int pointer=((length&63)<<8)|data[offset++];labels.Add(Name(data,ref pointer,depth+1));return string.Join(".",labels).ToLowerInvariant();}
    if(length>63||offset+length>data.Length)throw new InvalidDataException("Invalid DNS label");labels.Add(Encoding.UTF8.GetString(data,offset,length));offset+=length;
   }throw new InvalidDataException("DNS name too long");
  }
  internal static List<Record> Decode(byte[] data) {
   var records=new List<Record>();if(data.Length<12||(U16(data,2)&32768)==0)return records;
   int questions=U16(data,4),count=U16(data,6)+U16(data,8)+U16(data,10),offset=12;
   if(questions>100||count>512)throw new InvalidDataException("Oversized DNS reply");
   for(int i=0;i<questions;i++){Name(data,ref offset);offset+=4;if(offset>data.Length)throw new InvalidDataException("Truncated DNS question");}
   for(int i=0;i<count;i++){
    string owner=Name(data,ref offset);int type=U16(data,offset),length=U16(data,offset+8),start=offset+10,end=start+length;
    if(end>data.Length)throw new InvalidDataException("Truncated DNS record");
    if(type==33&&length>=7){int pos=start+6;var target=Name(data,ref pos);if(pos>end)throw new InvalidDataException("Invalid DNS SRV record");records.Add(new Record{Name=owner,Type=type,Target=target,Port=U16(data,start+4)});}
    if(type==1&&length==4)records.Add(new Record{Name=owner,Type=type,Address=new IPAddress(data.Skip(start).Take(4).ToArray()).ToString()});
    if(type==12){int pos=start;var target=Name(data,ref pos);if(pos>end)throw new InvalidDataException("Invalid DNS PTR record");records.Add(new Record{Name=owner,Type=type,Target=target});}
    offset=end;
   }return records;
  }
  internal static byte[] Query(string name,int type) {
   using(var stream=new MemoryStream()){
    stream.Write(new byte[]{78,69,0,0,0,1,0,0,0,0,0,0},0,12);
    foreach(string label in name.Split('.')){var bytes=Encoding.UTF8.GetBytes(label);if(bytes.Length>63)throw new InvalidDataException("Invalid DNS query");stream.WriteByte((byte)bytes.Length);stream.Write(bytes,0,bytes.Length);}
    stream.Write(new byte[]{0,(byte)(type>>8),(byte)type,0,1},0,5);return stream.ToArray();
   }
  }
  internal static void SelfTest(Action<bool,string> check) {
   var bluetooth=new HashSet<string>(StringComparer.OrdinalIgnoreCase){"COM7"};
   check(Classify("USB001",false,bluetooth)=="usb","USB discovery filters actual USB ports");
   check(Classify("BTH001",false,bluetooth)=="bluetooth","Bluetooth native port classification");
   check(Classify("COM7:",false,bluetooth)=="bluetooth","Bluetooth serial port classification");
   check(Classify("COM8:",false,bluetooth)=="windows","Unrelated serial port is not guessed Bluetooth");
   check(Classify("IP_192.0.2.1",false,bluetooth)=="network","Ethernet/Wi-Fi port classification");
   check(Classify("vendor-port",true,bluetooth)=="network","Installed network port metadata");
   check(Decode(Query("_ipp._tcp.local",12)).Count==0,"DNS queries are not advertised printers");
   var service=Query("sample._pdl-datastream._tcp.local",33);var serviceName=service.Skip(12).Take(service.Length-16).ToArray();
   var host=Query("printer.local",1);var hostName=host.Skip(12).Take(host.Length-16).ToArray();
   var srv=new byte[]{0,0,0,0,35,140}.Concat(hostName).ToArray();
   var packet=new byte[]{0,0,128,0,0,0,0,2,0,0,0,0}.Concat(serviceName).Concat(new byte[]{0,33,0,1,0,0,0,60,0,(byte)srv.Length}).Concat(srv)
    .Concat(hostName).Concat(new byte[]{0,1,0,1,0,0,0,60,0,4,192,0,2,10}).ToArray();
   var decoded=Decode(packet);check(decoded.Count==2&&decoded[0].Port==9100&&decoded[0].Target=="printer.local"&&decoded[1].Address=="192.0.2.10","Printer SRV and IPv4 advertisements decoded");
   var raw=Program.Obj(Devices(decoded).Single());check(Program.Text(Program.Get(raw,"connection_type"))=="network"&&Program.Text(Program.Get(raw,"address"))=="192.0.2.10:9100","Advertised RAW device retains exact address");
   decoded[0].Name="office._ipp._tcp.local";decoded[0].Port=631;var ipp=Program.Obj(Devices(decoded).Single());check(Program.Text(Program.Get(ipp,"connection_type"))=="unsupported","IPP device is detected without falsely offering RAW output");
   bool rejected=false;try{Decode(packet.Take(packet.Length-1).ToArray());}catch(InvalidDataException){rejected=true;}check(rejected,"Truncated network advertisement refused");
   var cycle=new byte[]{0,0,128,0,0,0,0,1,0,0,0,0,192,12};rejected=false;try{Decode(cycle);}catch(InvalidDataException){rejected=true;}check(rejected,"Cyclic DNS pointers bounded");
  }
  static bool Service(string name){return Regex.IsMatch(name??"",@"\._(?:pdl-datastream|ipps?)\._tcp\.local$");}
  static IEnumerable<object> Network(List<string> notes) {
   var records=new List<Record>();var asked=new HashSet<string>();
   try{using(var client=new UdpClient(AddressFamily.InterNetwork)){
    client.Client.Bind(new IPEndPoint(IPAddress.Any,0));client.Client.ReceiveTimeout=350;var multicast=new IPEndPoint(IPAddress.Parse("224.0.0.251"),5353);
    foreach(var service in new[]{"_pdl-datastream._tcp.local","_ipp._tcp.local","_ipps._tcp.local"}){var query=Query(service,12);client.Send(query,query.Length,multicast);}
    var timer=Stopwatch.StartNew();while(timer.ElapsedMilliseconds<3500&&records.Count<1000){
     try{var remote=new IPEndPoint(IPAddress.Any,0);var packet=client.Receive(ref remote);records.AddRange(Decode(packet));}
     catch(SocketException e){if(e.SocketErrorCode==SocketError.TimedOut)continue;throw;}
     catch(InvalidDataException){continue;}
     foreach(var row in records.ToArray()){
      string target=null;int type=0;
      if(row.Type==12&&Service(row.Target)){target=row.Target;type=33;}
      else if(row.Type==33&&Service(row.Name)&&(row.Target??"").EndsWith(".local",StringComparison.Ordinal)){target=row.Target;type=1;}
      if(target==null||asked.Count>=128||records.Any(r=>r.Type==type&&r.Name==target)||!asked.Add(type+":"+target))continue;
      var query=Query(target,type);client.Send(query,query.Length,multicast);
     }
    }
   }}catch(Exception e){notes.Add("Local network discovery unavailable: "+e.Message);}
   return Devices(records);
  }
  static IEnumerable<object> Devices(List<Record> records) {
   var devices=new List<object>();var seen=new HashSet<string>();
   foreach(var row in records.Where(r=>r.Type==33&&Service(r.Name))){
    var host=records.FirstOrDefault(r=>r.Type==1&&r.Name==row.Target);if(host==null||row.Port<1||row.Port>65535)continue;
    var address=host.Address+":"+row.Port;if(!seen.Add(address))continue;bool raw=row.Name.EndsWith("._pdl-datastream._tcp.local",StringComparison.Ordinal);
    var name=row.Name.Substring(0,row.Name.IndexOf("._",StringComparison.Ordinal));if(name.Length>240)name=name.Substring(0,240);
    devices.Add(new Dictionary<string,object>{{"name",name},{"address",address},{"connection_type",raw?"network":"unsupported"},{"transport","network"},{"source","Local mDNS advertisement"},{"note",raw?"RAW service advertised; verify ESC/POS compatibility before printing.":"IPP device detected; use its installed Windows driver queue for printing."}});
   }return devices;
  }
 }
}
