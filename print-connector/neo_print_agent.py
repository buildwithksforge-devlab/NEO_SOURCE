#!/usr/bin/env python3
"""NEO scoped HTTPS print agent. Python 3.9+. Uses explicit local printer allowlist."""
import json,os,sys,time,re,socket,ipaddress,urllib.request,urllib.error
ESC=b'\x1b'; GS=b'\x1d'
class DeliveryError(Exception):
 def __init__(self,msg,uncertain=False): super().__init__(msg);self.uncertain=uncertain

def render(job,width=42):
 p=job.get('payload') or {}; title=str(job.get('title') or p.get('title') or 'NEO TICKET')
 lines=['NEO HOSPITALITY',title,'-'*width]
 for key in ('property','station','reference','table','server'):
  if p.get(key):lines.append(f'{key.upper()}: {p[key]}')
 for item in p.get('items') or []:
  if isinstance(item,dict):
   lines.append(f"{item.get('quantity',item.get('qty',1))} x {item.get('name',item.get('item_name','ITEM'))}")
   for m in item.get('modifiers') or []:lines.append(' + '+(str(m.get('name')) if isinstance(m,dict) else str(m)))
   if item.get('instructions') or item.get('notes'):lines.append('! '+str(item.get('instructions') or item.get('notes')))
 for line in p.get('lines') or []:
  lines.append(str(line if not isinstance(line,dict) else line.get('name',line)))
 if p.get('lines_text'):lines.extend(str(p['lines_text']).splitlines())
 lines+=['-'*width,'PRINT DELIVERY IS UNVERIFIED','','','']
 encoded='\n'.join(lines).encode('cp437',errors='replace')
 return ESC+b'@'+encoded+GS+b'V\x41\x03'

def config_check(cfg):
 endpoint=str(cfg.get('endpoint',''))
 if not (endpoint.startswith('https://') or endpoint.startswith('http://localhost:')):raise ValueError('HTTPS endpoint required')
 if '/api/public/print-agent' not in endpoint:raise ValueError('Endpoint must be /api/public/print-agent')
 if not cfg.get('printers'):raise ValueError('No printers configured')
 for pid,p in cfg['printers'].items():
  if not re.fullmatch(r'[0-9a-fA-F-]{36}',pid):raise ValueError('Printer ID must be NEØ UUID')
  kind=p.get('type')
  if kind=='network':
   ip=ipaddress.ip_address(p['host'])
   if not (ip.is_private or ip.is_loopback) or ip.is_multicast:raise ValueError('LAN IP required')
   if int(p.get('port',9100))!=9100:raise ValueError('Only TCP 9100 enabled')
  elif kind=='windows_spooler':
   if not p.get('printer_name'):raise ValueError('Windows printer_name required')
  elif kind=='bluetooth_classic':
   if not re.fullmatch(r'COM\d{1,3}',str(p.get('port','')).upper()):raise ValueError('Bluetooth COM port required')
  else:raise ValueError('Unsupported printer type '+str(kind))
 return cfg

def send(p,data):
 kind=p['type']
 if kind=='network':
  try:s=socket.create_connection((p['host'],int(p.get('port',9100))),timeout=6)
  except OSError as e:raise DeliveryError('Connection failed: '+str(e))
  count=0
  try:
   s.settimeout(6)
   while count<len(data):
    n=s.send(data[count:]);
    if not n:raise OSError('socket closed')
    count+=n
  except OSError as e:raise DeliveryError(str(e),uncertain=count>0)
  finally:s.close()
 elif kind=='windows_spooler':
  try:import win32print
  except ImportError:raise DeliveryError('Run: py -m pip install pywin32')
  try:h=win32print.OpenPrinter(p['printer_name'])
  except Exception as e:raise DeliveryError(str(e))
  started=False
  try:
   win32print.StartDocPrinter(h,1,('NEO print job',None,'RAW'));started=True
   win32print.StartPagePrinter(h)
   n=win32print.WritePrinter(h,data)
   win32print.EndPagePrinter(h);win32print.EndDocPrinter(h)
   if n!=len(data):raise DeliveryError('Spooler accepted partial data',True)
  except DeliveryError:raise
  except Exception as e:raise DeliveryError(str(e),started)
  finally:win32print.ClosePrinter(h)
 elif kind=='bluetooth_classic':
  port=p['port'].upper()
  try:f=open('\\\\.\\'+port,'wb',buffering=0)
  except OSError as e:raise DeliveryError(str(e))
  sent=0
  try:
   while sent<len(data):
    n=f.write(data[sent:sent+512]) or 0
    if n<=0:raise OSError('COM port did not accept bytes')
    sent+=n
  except OSError as e:raise DeliveryError(str(e),sent>0)
  finally:f.close()

def call(cfg,token,action,payload):
 req=urllib.request.Request(cfg['endpoint'].rstrip('/')+'/'+action,data=json.dumps(payload).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},method='POST')
 with urllib.request.urlopen(req,timeout=15) as response:return json.load(response)

def once(cfg,token,pid):
 result=call(cfg,token,'claim',{'printer_id':pid})
 job=result.get('job')
 if not job:return False
 # Once a job is claimed, NO blind repeat. Uncertainty must be reconciled by manager.
 outcome='completed';error=None
 try:send(cfg['printers'][pid],render(job,int(cfg['printers'][pid].get('width',42))))
 except DeliveryError as e:outcome='outcome_unknown' if e.uncertain else 'not_printed';error=str(e)
 except Exception as e:outcome='not_printed';error='Rendering failure: '+str(e)
 print(pid,job.get('job_id'),outcome,flush=True)
 for attempt in range(5):
  try:
   call(cfg,token,'finish',{'job_id':job['job_id'],'claim_token':job['claim_token'],'outcome':outcome,'error':error});return True
  except (urllib.error.URLError,OSError) as e:
   print('Result acknowledgement failed:',e,file=sys.stderr);time.sleep(3)
 raise RuntimeError('Job delivery acknowledgement unavailable; inspect job (do not resend blindly)')

def main():
 path=sys.argv[1] if len(sys.argv)>1 else os.path.join(os.path.dirname(__file__),'config.json')
 cfg=config_check(json.load(open(path,encoding='utf-8')))
 token=os.environ.get('NEO_PRINT_TOKEN','').strip()
 if not token:sys.exit('NEO_PRINT_TOKEN missing: create connector token in NEØ admin after deployment')
 print('NEO print agent started. Acknowledged=bytes accepted, never proof of paper.',flush=True)
 while True:
  for pid in cfg['printers']:
   try:once(cfg,token,pid)
   except urllib.error.HTTPError as e:
    print('HTTPS',e.code,e.read()[:200],file=sys.stderr)
    if e.code in (401,403):sys.exit('Connector credentials rejected')
   except Exception as e:print('Connector error:',e,file=sys.stderr)
  time.sleep(float(cfg.get('poll_seconds',3)))
if __name__=='__main__':main()
