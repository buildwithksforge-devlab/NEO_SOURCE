using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Printing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace NeoPrintAgent {
 public static class Program {
  internal static JavaScriptSerializer Json { get { return new JavaScriptSerializer { MaxJsonLength = 4194304 }; } }
  internal static readonly string Home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NEO", "PrintAgent");
  [STAThread] public static int Main(string[] args) {
   ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
   try {
    if(args.Length==2 && args[0]=="--self-test") { SelfTest(args[1]); return 0; }
    if(args.Length==3 && args[0]=="--discover") {File.WriteAllText(args[2],Json.Serialize(PrinterDiscovery.Find(args[1])));return 0;}
    if(args.Length==3 && args[0]=="--diagnostic-pdf") { PrinterTransport.Windows("Microsoft Print to PDF", new string[]{"NEO PRINT AGENT - DIAGNOSTIC ONLY","No sale, payment or stock operation.","Windows print driver handoff test.","Not proof of physical paper output."},args[1]); File.WriteAllText(args[2],"{\"submittedToWindows\":true,\"physicalPaperVerified\":false}"); return 0; }
    Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
    bool first; using(var mutex=new Mutex(true,"Local\\NEOPrintAgent",out first)) { if(!first) {MessageBox.Show("NEO Print Agent is already running. Open its printer icon in the notification area.","NEO Print Agent");return 0;} Application.Run(new AgentForm()); }
    return 0;
   } catch(Exception ex) { if(args.Length>0) { Console.Error.WriteLine(ex.Message); if(args.Length==2)File.WriteAllText(args[1]+".error.txt",ex.ToString()); return 1; } MessageBox.Show(ex.Message,"NEO Print Agent",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1; }
  }
  internal static string Text(object value) { return value==null?"":Convert.ToString(value,System.Globalization.CultureInfo.InvariantCulture); }
  internal static Dictionary<string,object> Obj(object value) {return value as Dictionary<string,object> ?? new Dictionary<string,object>();}
  internal static object Get(Dictionary<string,object> value,string key) {object result;return value.TryGetValue(key,out result)?result:null;}
  internal static string Clean(object value) {return Regex.Replace(Text(value),"[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]","").Replace("\r","");}
  internal static IEnumerable<object> Array(object value) {var list=value as IEnumerable; if(list==null || value is string || value is Dictionary<string,object>)return new object[0];return list.Cast<object>();}
  internal static void SelfTest(string output) {
   int checks=0; Action<bool,string> check=(ok,name)=>{if(!ok)throw new Exception("Self-test failed: "+name);checks++;};
   PrinterDiscovery.SelfTest(check);
   var config=AgentConfig.Parse("{\"apiBase\":\"https://neo.example/api/public/print-agent\",\"token\":\"neopc_"+new string('a',64)+"\"}");check(config.ApiBase=="https://neo.example/api/public/print-agent","API path");
   foreach(var bad in new[]{"http://neo.example/api/public/print-agent","https://user:secret@neo.example/api/public/print-agent","https://neo.example/other"}) {bool denied=false;try{AgentConfig.Parse(Json.Serialize(new{apiBase=bad,token=config.Token}));}catch{denied=true;}check(denied,"Reject unsafe API base");}
   check(Clean("A\u001bB\u0000C")=="ABC","Printer control injection removed");
   var payload=new Dictionary<string,object>{{"document",new Dictionary<string,object>{{"number","SAMPLE-ONLY"}}},{"property",new Dictionary<string,object>{{"name","Sample Property"},{"currency","KES"}}},{"lines",new object[]{new Dictionary<string,object>{{"description","Sample meal"},{"quantity",1},{"unit_price",1854},{"total",1854}}}},{"totals",new object[]{new Dictionary<string,object>{{"label","Tendered"},{"amount",2000}},new Dictionary<string,object>{{"label","Change"},{"amount",146}}}}};
   var job=new Dictionary<string,object>{{"title","SAMPLE ONLY"},{"payload",payload}};var rendered=ReceiptRenderer.Render(job);check(rendered.Any(x=>x.Contains("SAMPLE-ONLY")),"Document identifier");check(rendered.Any(x=>x.Contains("2,000.00")),"Tender preserved");check(rendered.Any(x=>x.Contains("146.00")),"Change preserved");job["payload"]=new Dictionary<string,object>{{"document",payload}};check(ReceiptRenderer.Render(job).SequenceEqual(rendered),"Installed canonical payload wrapper supported");
   check(PrinterTransport.IsVirtual("Microsoft Print to PDF"),"PDF is not physical proof");check(PrinterTransport.IsVirtual("OneNote (Desktop)"),"OneNote is not physical proof");check(!PrinterTransport.IsVirtual("EPSON TM-T20"),"Physical queue allowed");
   job["feedback_qr"]=Enumerable.Range(0,29).Select(row=>row==8?new string('0',8)+"1"+new string('0',20):new string('0',29)).ToArray();
   using(var testLogo=new Bitmap(8,4)) using(var logoStream=new MemoryStream()) {
    using(var graphics=Graphics.FromImage(testLogo)) graphics.Clear(Color.Black);
    testLogo.Save(logoStream,System.Drawing.Imaging.ImageFormat.Png);
    payload["identity"]=new Dictionary<string,object>{{"brand", new Dictionary<string,object>{
     {"logoLight","data:image/png;base64,"+Convert.ToBase64String(logoStream.ToArray())},{"receiptPaybill","123456"},{"receiptTill","654321"}}}};
   }
   payload["meta"]=new Dictionary<string,object>{{"Waiter","Sample server"},{"Collected by","Sample receiver"}};
   payload["totals"]=new object[]{
    new Dictionary<string,object>{{"label","Catering levy \u00b7 Included"},{"amount",2.03m}},
    new Dictionary<string,object>{{"label","VAT \u00b7 Included"},{"amount",16.27m}},
    new Dictionary<string,object>{{"label","Total"},{"amount",120m}},
    new Dictionary<string,object>{{"label","Cash"},{"amount",120m}}
   };
   var taxReceipt=ReceiptRenderer.Render(job);
   check(System.Array.IndexOf(taxReceipt,"TAX BREAKDOWN")>=0&&System.Array.IndexOf(taxReceipt,"Total tax: KES 18.30")<System.Array.IndexOf(taxReceipt,"Total: KES 120.00")
    &&taxReceipt.Contains("Total tax: KES 18.30"),"Named taxes total separately before amount due");
   var bytes=PrinterTransport.EscPos(job);check(bytes[0]==27&&bytes[1]==64,"ESC/POS initialize");check(bytes[bytes.Length-3]==29,"ESC/POS cut");
   check(bytes[5]==29&&bytes[6]==118&&bytes[7]==48,"Logo raster precedes receipt text");
   var brandedText=Encoding.ASCII.GetString(bytes);
   check(brandedText.Contains("M-Pesa Paybill: 123456")&&brandedText.Contains("M-Pesa Till: 654321"),"Payment details kept in separate lines");
   check(brandedText.Contains("Served by: Sample server")&&brandedText.Contains("Received by: Sample receiver"),"Staff footer");
   check(brandedText.Contains("Scan to leave feedback\n"+(char)27+"a"),"Feedback raster precedes cut");
   var production=new Dictionary<string,object>{{"title","Kitchen ticket"},{"payload",new Dictionary<string,object>{{"lines",new object[]{"2 x Sample meal",null,"ALLERGY: peanuts"}}}}};var ticket=ReceiptRenderer.Render(production);check(ticket.Contains("2 x Sample meal")&&ticket.Contains("ALLERGY: peanuts")&&!ticket.Contains(""),"Production quantity and allergy preserved");
   {var listener=new TcpListener(IPAddress.Loopback,0);listener.Start();var endpoint=(IPEndPoint)listener.LocalEndpoint;var receive=Task.Run(()=>{using(var peer=listener.AcceptTcpClient())using(var stream=peer.GetStream())using(var sink=new MemoryStream()){stream.CopyTo(sink);return sink.ToArray();}});job["printer"]=new Dictionary<string,object>{{"connection_type","network"},{"address","127.0.0.1:"+endpoint.Port}};PrinterTransport.Deliver(job);check(receive.Wait(5000)&&receive.Result.SequenceEqual(bytes),"TCP printer receives complete ESC/POS receipt");listener.Stop();}

   File.WriteAllText(output,Json.Serialize(new{passed=true,checks=checks,liveJobsClaimed=false,physicalPaperVerified=false}));
  }
 }
 public sealed class AgentConfig {
  public string ApiBase; public string Token;
  public static AgentConfig Parse(string input) {
   var obj=Program.Obj(Program.Json.DeserializeObject(input));var api=Program.Text(Program.Get(obj,"apiBase")).Trim().TrimEnd('/');var token=Program.Text(Program.Get(obj,"token")).Trim();Uri uri;
   if(!Uri.TryCreate(api,UriKind.Absolute,out uri)||uri.Scheme!="https"||uri.UserInfo!=""||uri.Query!=""||uri.Fragment!=""||!uri.AbsolutePath.EndsWith("/api/public/print-agent",StringComparison.Ordinal))throw new Exception("Choose a configuration downloaded from NEO with its secure print-agent address.");
   if(!Regex.IsMatch(token,"^neopc_[0-9a-f]{64}$"))throw new Exception("The pairing secret is invalid. Download a new agent configuration from NEO.");
   return new AgentConfig{ApiBase=api,Token=token};
  }
  public void Save() {Directory.CreateDirectory(Program.Home);var protectedToken=ProtectedData.Protect(Encoding.UTF8.GetBytes(Token),null,DataProtectionScope.CurrentUser);File.WriteAllText(Path.Combine(Program.Home,"connection.json"),Program.Json.Serialize(new{apiBase=ApiBase,protectedToken=Convert.ToBase64String(protectedToken)}));}
  public static AgentConfig Load() {var p=Path.Combine(Program.Home,"connection.json");if(!File.Exists(p))return null;var obj=Program.Obj(Program.Json.DeserializeObject(File.ReadAllText(p)));var token=Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(Program.Text(Program.Get(obj,"protectedToken"))),null,DataProtectionScope.CurrentUser));return Parse(Program.Json.Serialize(new{apiBase=Program.Get(obj,"apiBase"),token=token}));}
 }
 internal static class ReceiptRenderer {
  internal static Dictionary<string,object> Payload(Dictionary<string,object> job) {
   var payload=Program.Obj(Program.Get(job,"payload"));
   var wrapped=Program.Obj(Program.Get(payload,"document"));
   return wrapped.ContainsKey("document")||wrapped.ContainsKey("lines") ? wrapped : payload;
  }
  internal static string[] Feedback(Dictionary<string,object> job) {
   var rows=Program.Array(Program.Get(job,"feedback_qr")).Select(Program.Text).ToArray();
   return rows.Length>=21 && rows.Length<=177 && rows.All(row=>row.Length==rows.Length && row.All(ch=>ch=='0'||ch=='1')) ? rows : new string[0];
  }
  internal static Bitmap Logo(Dictionary<string,object> job) {
   var payload=Payload(job);
   if(!Program.Obj(Program.Get(payload,"document")).ContainsKey("number")) return null;
   var property=Program.Obj(Program.Get(payload,"property"));
   var brand=Program.Obj(Program.Get(Program.Obj(Program.Get(payload,"identity")),"brand"));
   foreach(var value in new[]{Program.Get(property,"logo_url"),Program.Get(brand,"logoLight"),Program.Get(brand,"logoDark")}) {
    var url=Program.Text(value);
    if(url.Length>500000 || !Regex.IsMatch(url,@"^data:image/(png|jpeg);base64,",RegexOptions.IgnoreCase)) continue;
    try {
     using(var stream=new MemoryStream(Convert.FromBase64String(url.Substring(url.IndexOf(',')+1))))
     using(var image=Image.FromStream(stream,true,true)) {
      if(image.Width>2000||image.Height>2000) continue;
      var ratio=Math.Min(320.0/image.Width,116.0/image.Height);
      var result=new Bitmap(Math.Max(1,(int)(image.Width*ratio)),Math.Max(1,(int)(image.Height*ratio)));
      using(var graphics=Graphics.FromImage(result)) {
       graphics.Clear(Color.White);
       graphics.DrawImage(image,0,0,result.Width,result.Height);
      }
      return result;
     }
    } catch(ArgumentException) { } catch(FormatException) { }
   }
   return null;
  }
  private static string Money(object amount,string currency) {decimal n;return decimal.TryParse(Program.Text(amount),System.Globalization.NumberStyles.Any,System.Globalization.CultureInfo.InvariantCulture,out n)?currency+" "+n.ToString("N2",System.Globalization.CultureInfo.InvariantCulture):Program.Clean(amount);}
  public static string[] Render(Dictionary<string,object> job) {
   var payload=Payload(job);var doc=Program.Obj(Program.Get(payload,"document"));var property=Program.Obj(Program.Get(payload,"property"));var identity=Program.Obj(Program.Get(payload,"identity"));var result=new List<string>();
   Action<object> add=value=>{foreach(var line in Program.Clean(value).Split('\n'))result.Add(line);};
   if(doc.Count==0) {add(Program.Get(job,"title"));foreach(var line in Program.Array(Program.Get(payload,"lines")))if(line!=null)add(line is Dictionary<string,object>?Program.Json.Serialize(line):line);return result.ToArray();}
   var currency=Program.Text(Program.Get(property,"currency"));if(currency=="")currency=Program.Text(Program.Get(identity,"currency"));
   add(Program.Get(property,"name"));add(Program.Get(doc,"title"));add(Program.Get(doc,"number"));add(Program.Get(doc,"date"));add(new string('-',32));
   foreach(var line in Program.Array(Program.Get(payload,"lines"))) {var row=Program.Obj(line);add(Program.Get(row,"description"));add("  "+Program.Text(Program.Get(row,"quantity"))+" x "+Money(Program.Get(row,"unit_price"),currency));add("  "+Money(Program.Get(row,"total"),currency));var note=Program.Get(row,"note");if(note!=null)add(note);}
   add(new string('-',32));
   bool hasTotal=false, hasPaymentHeading=false, hasTaxHeading=false;
   int taxRows=0;
   decimal taxTotal=0;
   Action addTaxTotal=()=>{
    if(taxRows>1)add("Total tax: "+Money(taxTotal,currency));
    taxRows=0;
    taxTotal=0;
   };
   foreach(var line in Program.Array(Program.Get(payload,"totals"))) {
    var row=Program.Obj(line);var label=Program.Text(Program.Get(row,"label"));
    label=System.Text.RegularExpressions.Regex.Replace(label,@"^Tax(?=\s*\u00b7|$)","Recorded tax",System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    bool isTax=!hasTotal && (label.Equals("Recorded tax",StringComparison.OrdinalIgnoreCase) ||
     System.Text.RegularExpressions.Regex.IsMatch(label,@"\u00b7\s*(Included|Added)$",System.Text.RegularExpressions.RegexOptions.IgnoreCase));
    if(!isTax&&taxRows>0)addTaxTotal();
    decimal tax;
    if(isTax&&decimal.TryParse(Program.Text(Program.Get(row,"amount")),System.Globalization.NumberStyles.Any,System.Globalization.CultureInfo.InvariantCulture,out tax)) {
     if(!hasTaxHeading){add("TAX BREAKDOWN");hasTaxHeading=true;}
     taxRows++;
     taxTotal+=tax;
    }
    if(hasTotal&&!hasPaymentHeading) {add("PAYMENTS & BALANCE");hasPaymentHeading=true;}
    add(label+": "+Money(Program.Get(row,"amount"),currency));
    if(label.Equals("Total",StringComparison.OrdinalIgnoreCase)||label.Equals("Grand total",StringComparison.OrdinalIgnoreCase)) hasTotal=true;
   }
   if(taxRows>0)addTaxTotal();
   var brand=Program.Obj(Program.Get(identity,"brand"));
   var instructions=new Dictionary<string,string>{{"receiptPaybill","M-Pesa Paybill"},{"receiptPaybillAccount","Paybill account"},{"receiptTill","M-Pesa Till"},{"receiptPaymentInstructions","Payment instructions"}};
   if(instructions.Keys.Any(key=>!string.IsNullOrWhiteSpace(Program.Text(Program.Get(brand,key))))) {
    add(new string('-',32));add("HOW TO PAY");
    foreach(var item in instructions) {var value=Program.Clean(Program.Get(brand,item.Key));if(value!="")add(item.Value+": "+value);}
   }
   add(new string('-',32));var meta=Program.Obj(Program.Get(payload,"meta"));
   var staff=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase){{"waiter","Served by"},{"served by","Served by"},{"cashier","Received by"},{"collected by","Received by"},{"received by","Received by"},{"checked by","Checked by"}};
   var footer=new Dictionary<string,string>();
   foreach(var item in meta) {
    if(!(item.Value is string || item.Value is decimal || item.Value is int || item.Value is double)) continue;
    var key=item.Key.Replace('_',' ');string label;
    if(staff.TryGetValue(key,out label)) footer[label]=Program.Clean(item.Value);
    else if(!key.Equals("qr payload",StringComparison.OrdinalIgnoreCase)) add(item.Key+": "+Program.Clean(item.Value));
   }
   foreach(var entry in footer) add(entry.Key+": "+entry.Value);
   add("Thank you.");return result.ToArray();
  }
 }
 internal sealed class DeliveryException:Exception {public readonly bool Unknown;public DeliveryException(string message,bool unknown):base(message){Unknown=unknown;}}
 internal static class PrinterTransport {
  public static bool IsVirtual(string name) {return Regex.IsMatch(name??"","Print to PDF|OneNote|XPS Document|Fax",RegexOptions.IgnoreCase);}
  private static byte[] Raster(int width,int height,Func<int,int,bool> ink) {
   int stride=(width+7)/8;
   var bytes=new byte[8+stride*height];
   new byte[]{29,118,48,0,(byte)stride,(byte)(stride>>8),(byte)height,(byte)(height>>8)}.CopyTo(bytes,0);
   for(int y=0;y<height;y++) for(int x=0;x<width;x++) if(ink(x,y)) bytes[8+y*stride+x/8]|=(byte)(128>>(x%8));
   return new byte[]{27,97,1}.Concat(bytes).Concat(new byte[]{10,27,97,0}).ToArray();
  }
  public static byte[] EscPos(Dictionary<string,object> job) {
   var body=Encoding.ASCII.GetBytes(string.Join("\n",ReceiptRenderer.Render(job))+"\n");
   using(var logo=ReceiptRenderer.Logo(job)) {
    var head=logo==null ? new byte[0] : Raster(logo.Width,logo.Height,(x,y)=>logo.GetPixel(x,y).GetBrightness()<0.62);
    var qr=ReceiptRenderer.Feedback(job);
    var size=qr.Length==0 ? 0 : Math.Max(2,Math.Min(4,208/qr.Length));
    var feedback=size==0 ? new byte[0] : Encoding.ASCII.GetBytes("Scan to leave feedback\n").Concat(
      Raster(qr.Length*size,qr.Length*size,(x,y)=>qr[y/size][x/size]=='1')).ToArray();
    return new byte[]{27,64}.Concat(head).Concat(body).Concat(feedback).Concat(new byte[]{10,10,29,86,0}).ToArray();
   }
  }
  public static void Deliver(Dictionary<string,object> job) {
   var printer=Program.Obj(Program.Get(job,"printer"));var kind=Program.Text(Program.Get(printer,"connection_type")).ToLowerInvariant();var address=Program.Text(Program.Get(printer,"address")).Trim();
   if(new[]{"windows","spooler","usb"}.Contains(kind)) {if(IsVirtual(address))throw new DeliveryException("A virtual printer cannot confirm a physical receipt. Select an installed receipt or kitchen printer.",false);using(var logo=ReceiptRenderer.Logo(job)) Windows(address,ReceiptRenderer.Render(job),null,logo,ReceiptRenderer.Feedback(job));return;}
   if(new[]{"network","tcp","ethernet","lan"}.Contains(kind)) {Uri uri;if(!Uri.TryCreate("tcp://"+address.Replace("tcp://",""),UriKind.Absolute,out uri)||string.IsNullOrWhiteSpace(uri.Host))throw new DeliveryException("Invalid network printer address",false);var port=uri.Port>0?uri.Port:9100;bool connected=false;try{using(var client=new TcpClient()){var task=client.ConnectAsync(uri.Host,port);if(!task.Wait(15000))throw new TimeoutException("Printer connection timed out");connected=true;client.SendTimeout=15000;var bytes=EscPos(job);using(var stream=client.GetStream()){stream.Write(bytes,0,bytes.Length);stream.Flush();}}}catch(Exception e){throw new DeliveryException(e.GetBaseException().Message,connected);}return;}
   throw new DeliveryException("Unsupported printer connection. Choose Windows or network printing.",false);
  }
  public static void Windows(string name,string[] source,string output,Bitmap logo=null,string[] feedback=null) {
   if(!PrinterSettings.InstalledPrinters.Cast<string>().Contains(name))throw new DeliveryException("The assigned Windows printer is not installed on this computer",false);
   bool submitted=false;try {using(var doc=new PrintDocument()){doc.PrinterSettings.PrinterName=name;doc.DocumentName=output==null?"NEO receipt / production ticket":"NEO DIAGNOSTIC ONLY";doc.PrintController=new StandardPrintController();
    if(output!=null){doc.PrinterSettings.PrintToFile=true;doc.PrinterSettings.PrintFileName=Path.GetFullPath(output);}
    doc.DefaultPageSettings.Margins=new Margins(8,8,8,8);int index=0;var wrapped=new List<string>();
    bool logoPending=logo!=null,feedbackPending=feedback!=null&&feedback.Length>0;
    doc.PrintPage+=(sender,args)=>{using(var font=new Font("Consolas",8)){float y=args.MarginBounds.Top;float lineHeight=font.GetHeight(args.Graphics)+2;
     if(wrapped.Count==0)foreach(var text in source){string remaining=Program.Clean(text);while(remaining.Length>0){int length=remaining.Length;while(length>1&&args.Graphics.MeasureString(remaining.Substring(0,length),font).Width>args.MarginBounds.Width)length--;wrapped.Add(remaining.Substring(0,length));remaining=remaining.Substring(length);}if(text.Length==0)wrapped.Add("");}
     if(logoPending) {
      float width=Math.Min(155,args.MarginBounds.Width),height=width*logo.Height/logo.Width;
      if(height>55) { width*=55/height;height=55; }
      args.Graphics.DrawImage(logo,args.MarginBounds.Left+(args.MarginBounds.Width-width)/2,y,width,height);
      y+=height+8;logoPending=false;
     }
     while(index<wrapped.Count&&y+lineHeight<=args.MarginBounds.Bottom){args.Graphics.DrawString(wrapped[index++],font,Brushes.Black,args.MarginBounds.Left,y);y+=lineHeight;}
     if(index==wrapped.Count&&feedbackPending) {
      float dot=Math.Min(105,Math.Min(args.MarginBounds.Width,args.MarginBounds.Height-lineHeight))/feedback.Length;
      float extent=dot*feedback.Length;
      if(dot<=0) feedbackPending=false;
      else if(y+lineHeight+extent<=args.MarginBounds.Bottom) {
       args.Graphics.DrawString("Scan to leave feedback",font,Brushes.Black,args.MarginBounds.Left,y);y+=lineHeight;
       float left=args.MarginBounds.Left+(args.MarginBounds.Width-extent)/2;
       for(int row=0;row<feedback.Length;row++) for(int col=0;col<feedback.Length;col++) if(feedback[row][col]=='1')
        args.Graphics.FillRectangle(Brushes.Black,left+col*dot,y+row*dot,dot,dot);
       feedbackPending=false;
      }
     }
     args.HasMorePages=index<wrapped.Count||feedbackPending;}};
    submitted=true;doc.Print();
   }}catch(Exception e){throw new DeliveryException(e.Message,submitted);}
  }
 }
 internal sealed class AgentForm:Form {
  readonly Label status=new Label();readonly NotifyIcon tray=new NotifyIcon();readonly Button connect=new Button();CancellationTokenSource cancel;AgentConfig config;
  public AgentForm() {
   Text="NEO Print Agent";Size=new Size(560,255);FormBorderStyle=FormBorderStyle.FixedDialog;MaximizeBox=false;
   var heading=new Label{Text="NEO property print connection",Left=20,Top=20,Width=500,Height=26,Font=new Font("Segoe UI",13,FontStyle.Bold)};
   var help=new Label{Text="In NEO > Printers, pair this computer and download its configuration.\nImport that file here. Keep this agent running in the notification area.",Left=20,Top=57,Width=500,Height=43};
   status.SetBounds(20,108,500,40);connect.SetBounds(20,158,240,32);connect.Text="Import pairing configuration";connect.Click+=(s,e)=>Import();
   var hide=new Button{Text="Keep running in background",Left=275,Top=158,Width=245,Height=32};hide.Click+=(s,e)=>Hide();Controls.AddRange(new Control[]{heading,help,status,connect,hide});
   var menu=new ContextMenuStrip();menu.Items.Add("Open status",null,(s,e)=>{Show();WindowState=FormWindowState.Normal;Activate();});
   var startup=new ToolStripMenuItem("Start with Windows");startup.CheckOnClick=true;startup.Checked=StartupConfigured();startup.CheckedChanged+=(s,e)=>SetStartup(startup.Checked);menu.Items.Add(startup);
   menu.Items.Add("Exit agent",null,(s,e)=>{if(cancel!=null)cancel.Cancel();tray.Visible=false;Application.Exit();});tray.Icon=SystemIcons.Application;tray.Text="NEO Print Agent";tray.ContextMenuStrip=menu;tray.Visible=true;tray.DoubleClick+=(s,e)=>Show();
   FormClosing+=(s,e)=>{if(e.CloseReason==CloseReason.UserClosing){e.Cancel=true;Hide();}};
   Shown+=(s,e)=>{try{config=AgentConfig.Load();if(config==null)Status("Not paired. Import the configuration from NEO.");else Start();}catch{Status("Saved pairing could not be opened. Import a fresh configuration.");}};
  }
  bool StartupConfigured(){using(var key=Microsoft.Win32.Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")){return key!=null&&key.GetValue("NEOPrintAgent")!=null;}}
  void SetStartup(bool enabled){try{using(var key=Microsoft.Win32.Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run",true)){if(enabled)key.SetValue("NEOPrintAgent","\""+Application.ExecutablePath+"\"");else key.DeleteValue("NEOPrintAgent",false);}}catch(Exception e){MessageBox.Show(e.Message,"Windows startup setting");}}
  void Import(){using(var picker=new OpenFileDialog{Filter="NEO pairing configuration (*.json)|*.json",Title="Choose the configuration downloaded from NEO"}){if(picker.ShowDialog()!=DialogResult.OK)return;try{var next=AgentConfig.Parse(File.ReadAllText(picker.FileName));if(MessageBox.Show("Connect this computer to "+new Uri(next.ApiBase).Host+"?\nIts assigned printer jobs can then reach this computer.","Connect NEO printer agent",MessageBoxButtons.OKCancel,MessageBoxIcon.Question)!=DialogResult.OK)return;if(cancel!=null)cancel.Cancel();next.Save();config=next;Start();}catch(Exception e){MessageBox.Show(e.Message,"Pairing configuration",MessageBoxButtons.OK,MessageBoxIcon.Error);}}}
  void Status(string text){if(IsDisposed)return;if(InvokeRequired){try{BeginInvoke(new Action<string>(Status),text);}catch{}return;}status.Text=text;var caption="NEO: "+text;tray.Text=caption.Substring(0,Math.Min(63,caption.Length));}
  void Log(string message){try{Directory.CreateDirectory(Program.Home);File.AppendAllText(Path.Combine(Program.Home,"agent.log"),DateTimeOffset.UtcNow.ToString("o")+" "+message+Environment.NewLine);}catch{}}
  async Task<Dictionary<string,object>> Call(HttpClient http,AgentConfig current,string action,object body,CancellationToken ct){using(var request=new HttpRequestMessage(HttpMethod.Post,current.ApiBase+"/"+action)){request.Headers.Authorization=new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer",current.Token);request.Content=new StringContent(Program.Json.Serialize(body),Encoding.UTF8,"application/json");using(var response=await http.SendAsync(request,ct)){if(!response.IsSuccessStatusCode)throw new Exception("NEO connection returned "+(int)response.StatusCode+" for "+action);return Program.Obj(Program.Json.DeserializeObject(await response.Content.ReadAsStringAsync()));}}}
  void Start(){cancel=new CancellationTokenSource();var ct=cancel.Token;var current=config;Status("Connecting to NEO…");Task.Run(async()=>{using(var http=new HttpClient{Timeout=TimeSpan.FromSeconds(25)}){while(!ct.IsCancellationRequested){try{
   var reply=await Call(http,current,"printers",new{},ct);var printers=Program.Array(Program.Get(reply,"printers")).Select(Program.Obj).ToArray();Status(printers.Length==0?"Connected. No printer is assigned in NEO.":"Connected. Waiting for assigned printer jobs.");
   try{var discovery=await Call(http,current,"discovery",new{},ct);var dr=Program.Obj(Program.Get(discovery,"request"));if(dr.Count>0){var kind=Program.Text(Program.Get(dr,"kind"));var result=PrinterDiscovery.Find(kind);await Call(http,current,"discovered",new{request_id=Program.Get(dr,"request_id"),result=result},ct);}}catch(Exception e){Log("Discovery: "+e.Message);}
   var savedDirectory=Path.Combine(Program.Home,"deliveries");if(Directory.Exists(savedDirectory))foreach(var saved in Directory.GetFiles(savedDirectory,"*.json")){var savedAck=Program.Obj(Program.Json.DeserializeObject(File.ReadAllText(saved)));if(savedAck.Count>0){try{await Call(http,current,"finish",savedAck,ct);File.Delete(saved);}catch(Exception e){if(e.Message.Contains("409")){File.Move(saved,saved+".review-"+DateTime.UtcNow.Ticks);Log("Expired claim retained for manual review: "+Path.GetFileName(saved));}else throw;}}}
   foreach(var printer in printers){ct.ThrowIfCancellationRequested();var claim=await Call(http,current,"claim",new{printer_id=Program.Get(printer,"id")},ct);var job=Program.Obj(Program.Get(claim,"job"));if(job.Count==0)continue;var outcome="completed";string error=null;Guid jobGuid,claimGuid;if(!Guid.TryParse(Program.Text(Program.Get(job,"job_id")),out jobGuid)||!Guid.TryParse(Program.Text(Program.Get(job,"claim_id")),out claimGuid))throw new Exception("NEO returned an invalid print job identity");var deliveryDirectory=Path.Combine(Program.Home,"deliveries");Directory.CreateDirectory(deliveryDirectory);var journal=Path.Combine(deliveryDirectory,jobGuid.ToString("D")+".json");
    File.WriteAllText(journal,Program.Json.Serialize(new{job_id=Program.Get(job,"job_id"),claim_id=Program.Get(job,"claim_id"),outcome="outcome_unknown",error="Agent stopped before delivery outcome was saved. Review physical output before retrying."}));
    try{PrinterTransport.Deliver(job);}catch(DeliveryException e){outcome=e.Unknown?"outcome_unknown":"not_printed";error=e.Message;}catch(Exception e){outcome="outcome_unknown";error=e.Message;}
    var ack=new{job_id=Program.Get(job,"job_id"),claim_id=Program.Get(job,"claim_id"),outcome=outcome,error=error};File.WriteAllText(journal,Program.Json.Serialize(ack));
    // Delivery is never repeated just because its acknowledgement failed.
    bool acknowledged=false;for(int attempt=0;attempt<3&&!acknowledged;attempt++){try{await Call(http,current,"finish",ack,ct);acknowledged=true;}catch{}if(!acknowledged)await Task.Delay(1000,ct);}
    if(acknowledged)File.Delete(journal);else throw new Exception("Print outcome needs review in NEO; acknowledgement failed. Do not resend automatically.");
    Status(outcome=="completed"?"Sent to the assigned printer.":"Printer attention required: "+error);Log("Job "+Program.Text(Program.Get(job,"job_id"))+": "+outcome);
   }
  }catch(OperationCanceledException){break;}catch(Exception e){Status(e.Message);Log(e.Message);}await Task.Delay(2500,ct).ContinueWith(t=>{});}}},ct);}
 }
}
