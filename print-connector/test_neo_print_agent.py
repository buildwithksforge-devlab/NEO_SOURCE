import unittest, socket, threading, uuid, sys, os
sys.path.insert(0,os.path.dirname(__file__))
import neo_print_agent as a
class TestAgent(unittest.TestCase):
 def test_render(self):
  b=a.render({'title':'Kitchen','payload':{'items':[{'quantity':2,'name':'Burger','notes':'No onion'}]}})
  self.assertIn(b'2 x Burger',b);self.assertIn(b'No onion',b);self.assertTrue(b.endswith(a.GS+b'V\x41\x03'))
 def test_reject_public(self):
  with self.assertRaises(ValueError):a.config_check({'endpoint':'https://x/api/public/print-agent','printers':{str(uuid.uuid4()):{'type':'network','host':'8.8.8.8'}}})
 def test_no_printers(self):
  with self.assertRaises(ValueError):a.config_check({'endpoint':'https://x/api/public/print-agent','printers':{}})
 def test_serial_config(self):
  self.assertTrue(a.config_check({'endpoint':'https://x/api/public/print-agent','printers':{str(uuid.uuid4()):{'type':'bluetooth_classic','port':'COM7'}}}))
 def test_tcp_bytes(self):
  listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(1)
  data=[]
  def listen():
   c,_=listener.accept();data.append(c.recv(65535));c.close()
  t=threading.Thread(target=listen);t.start()
  p=listener.getsockname()[1]
  a.send({'type':'network','host':'127.0.0.1','port':p},b'NEO TEST')
  t.join(timeout=3);listener.close();self.assertEqual(data,[b'NEO TEST'])
if __name__=='__main__':unittest.main()
