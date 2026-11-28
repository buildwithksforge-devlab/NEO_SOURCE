import { PGlite } from "@electric-sql/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;

const org = id(1201);
const branch = id(1202);
const otherBranch = id(1203);
const actor = id(1204);
const period = id(1205);

const cash = id(1210);
const liability = id(1211);
const receivable = id(1212);
const revenue = id(1213);

const canonicalSQL = Buffer.from(
  "Q1JFQVRFIE9SIFJFUExBQ0UgRlVOQ1RJT04gcHVibGljLmZpbl9wb3N0X2pvdXJuYWwoX2pvdXJuYWwgdXVpZCkKIFJFVFVSTlMganNvbmIKIExBTkdVQUdFIHBscGdzcWwKIFNFQ1VSSVRZIERFRklORVIKIFNFVCBzZWFyY2hfcGF0aCBUTyAncHVibGljJwpBUyAkZnVuY3Rpb24kCkRFQ0xBUkUgaiBwdWJsaWMuam91cm5hbF9lbnRyaWVzOyBwIHB1YmxpYy5hY2NvdW50aW5nX3BlcmlvZHM7IGQgbnVtZXJpYzsgYyBudW1lcmljOyBiYWQgaW50OwpCRUdJTgogIFNFTEVDVCAqIElOVE8gaiBGUk9NIHB1YmxpYy5qb3VybmFsX2VudHJpZXMgV0hFUkUgaWQgPSBfam91cm5hbAogICAgICBBTkQgb3JnYW5pemF0aW9uX2lkID0gcHVibGljLmN1cnJlbnRfb3JnX2lkKCkKICAgICAgRk9SIFVQREFURTsKICBJRiBqLmlkIElTIE5VTEwgVEhFTiBSQUlTRSBFWENFUFRJT04gJ0pvdXJuYWwgbm90IGZvdW5kJzsgRU5EIElGOwogIElGIGoub3JnYW5pemF0aW9uX2lkIDw+IGN1cnJlbnRfb3JnX2lkKCkgVEhFTiBSQUlTRSBFWENFUFRJT04gJ05vdCBwZXJtaXR0ZWQnOyBFTkQgSUY7CiAgSUYgTk9UIChwdWJsaWMubmVvX3N5c3RlbV9wb3N0aW5nKCkgT1IgaGFzX3Blcm1pc3Npb24oJ2ZpbmFuY2UnLCdhcHByb3ZlJykgT1IgaXNfb3JnX2FkbWluKCkpIFRIRU4KICAgIFJBSVNFIEVYQ0VQVElPTiAnWW91IGRvIG5vdCBoYXZlIHBlcm1pc3Npb24gdG8gcG9zdCBqb3VybmFscyc7CiAgRU5EIElGOwogIElGIHB1YmxpYy5uZW9fYnJhbmNoX2luX3Njb3BlKGouYnJhbmNoX2lkKQogICAgICAgSVMgTk9UIFRSVUUgVEhFTgogICAgICAgIFJBSVNFIEVYQ0VQVElPTiAnSm91cm5hbCBvdXRzaWRlIGF1dGhvcmlzZWQgcHJvcGVydHkgc2NvcGUnCiAgICAgICAgICBVU0lORyBFUlJDT0RFID0gJzQyNTAxJzsKICAgIEVORCBJRjsKCiAgICBJRiBwdWJsaWMubmVvX3N5c3RlbV9wb3N0aW5nKCkgSVMgTk9UIFRSVUUKICAgICAgIEFORCBqLmJyYW5jaF9pZCBJUyBOVUxMCiAgICAgICBBTkQgKHB1YmxpYy5jdXJyZW50X2FjY2Vzc19zY29wZSgpIElOICgnb3JnYW5pc2F0aW9uJywndGVjaG5pY2FsJykpIElTIE5PVCBUUlVFIFRIRU4KICAgICAgICBSQUlTRSBFWENFUFRJT04gJ09yZ2FuaXNhdGlvbi13aWRlIGpvdXJuYWwgcmVxdWlyZXMgb3JnYW5pc2F0aW9uIHNjb3BlJwogICAgICAgICAgVVNJTkcgRVJSQ09ERSA9ICc0MjUwMSc7CiAgICBFTkQgSUY7CgogICAgSUYgRVhJU1RTICgKICAgICAgICBTRUxFQ1QgMQogICAgICAgIEZST00gcHVibGljLmpvdXJuYWxfZW50cnlfbGluZXMgbAogICAgICAgIExFRlQgSk9JTiBwdWJsaWMuY2hhcnRfb2ZfYWNjb3VudHMgYQogICAgICAgICAgT04gYS5pZCA9IGwuYWNjb3VudF9pZAogICAgICAgIFdIRVJFIGwuam91cm5hbF9pZCA9IGouaWQKICAgICAgICAgIEFORCBhLm9yZ2FuaXphdGlvbl9pZCBJUyBESVNUSU5DVCBGUk9NIGoub3JnYW5pemF0aW9uX2lkCiAgICApIFRIRU4KICAgICAgICBSQUlTRSBFWENFUFRJT04gJ0pvdXJuYWwgYWNjb3VudCBiZWxvbmdzIHRvIGFub3RoZXIgb3JnYW5pc2F0aW9uJwogICAgICAgICAgVVNJTkcgRVJSQ09ERSA9ICc0MjUwMSc7CiAgICBFTkQgSUY7CgogICAgSUYgRVhJU1RTICgKICAgICAgICBTRUxFQ1QgMQogICAgICAgIEZST00gcHVibGljLmpvdXJuYWxfZW50cnlfbGluZXMgbAogICAgICAgIFdIRVJFIGwuam91cm5hbF9pZCA9IGouaWQKICAgICAgICAgIEFORCAoCiAgICAgICAgICAgIGwub3JnYW5pemF0aW9uX2lkIElTIERJU1RJTkNUIEZST00gai5vcmdhbml6YXRpb25faWQKICAgICAgICAgICAgT1IgcHVibGljLm5lb19icmFuY2hfaW5fc2NvcGUoCiAgICAgICAgICAgICAgICBDT0FMRVNDRShsLmJyYW5jaF9pZCwgai5icmFuY2hfaWQpCiAgICAgICAgICAgICkgSVMgTk9UIFRSVUUKICAgICAgICAgICkKICAgICkgVEhFTgogICAgICAgIFJBSVNFIEVYQ0VQVElPTiAnSm91cm5hbCBsaW5lcyBvdXRzaWRlIGF1dGhvcmlzZWQgc2NvcGUnCiAgICAgICAgICBVU0lORyBFUlJDT0RFID0gJzQyNTAxJzsKICAgIEVORCBJRjsKCiAgICBJRiBqLnN0YXR1cyA9ICdwb3N0ZWQnIFRIRU4gUkVUVVJOIGpzb25iX2J1aWxkX29iamVjdCgnb2snLCB0cnVlLCAnYWxyZWFkeV9wb3N0ZWQnLCB0cnVlLCAnam91cm5hbF9pZCcsIGouaWQpOyBFTkQgSUY7CiAgSUYgai5zdGF0dXMgTk9UIElOICgnZHJhZnQnLCdhcHByb3ZlZCcpIFRIRU4gUkFJU0UgRVhDRVBUSU9OICdKb3VybmFsIGNhbm5vdCBiZSBwb3N0ZWQgZnJvbSBzdGF0dXMgJScsIGouc3RhdHVzOyBFTkQgSUY7CgogIFNFTEVDVCBDT0FMRVNDRShzdW0oZGViaXQpLDApLCBDT0FMRVNDRShzdW0oY3JlZGl0KSwwKSBJTlRPIGQsIGMKICAgIEZST00gcHVibGljLmpvdXJuYWxfZW50cnlfbGluZXMgV0hFUkUgam91cm5hbF9pZCA9IGouaWQ7CiAgSUYgZCA9IDAgQU5EIGMgPSAwIFRIRU4gUkFJU0UgRVhDRVBUSU9OICdKb3VybmFsIGhhcyBubyBsaW5lcyc7IEVORCBJRjsKICBJRiBkIDw+IGMgVEhFTiBSQUlTRSBFWENFUFRJT04gJ0pvdXJuYWwgaXMgbm90IGJhbGFuY2VkIChkZWJpdCAlIHZzIGNyZWRpdCAlKScsIGQsIGM7IEVORCBJRjsKCiAgU0VMRUNUIGNvdW50KCopIElOVE8gYmFkIEZST00gcHVibGljLmpvdXJuYWxfZW50cnlfbGluZXMgbAogICAgSk9JTiBwdWJsaWMuY2hhcnRfb2ZfYWNjb3VudHMgYSBPTiBhLmlkID0gbC5hY2NvdW50X2lkCiAgICBXSEVSRSBsLmpvdXJuYWxfaWQgPSBqLmlkIEFORCAoYS5hY3RpdmUgPSBmYWxzZSBPUiBhLnBvc3RhYmxlID0gZmFsc2UgT1IgYS5pc19oZWFkZXIgPSB0cnVlKTsKICBJRiBiYWQgPiAwIFRIRU4gUkFJU0UgRVhDRVBUSU9OICdKb3VybmFsIHJlZmVyZW5jZXMgaW5hY3RpdmUgb3Igbm9uLXBvc3RhYmxlIGFjY291bnRzJzsgRU5EIElGOwoKICBTRUxFQ1QgKiBJTlRPIHAgRlJPTSBwdWJsaWMuZmluX3BlcmlvZF9mb3Ioai5vcmdhbml6YXRpb25faWQsIGouYWNjb3VudGluZ19kYXRlKTsKICBJRiBwLmlkIElTIE5VTEwgVEhFTiBSQUlTRSBFWENFUFRJT04gJ05vIGFjY291bnRpbmcgcGVyaW9kIGNvdmVycyAlJywgai5hY2NvdW50aW5nX2RhdGU7IEVORCBJRjsKICBJRiBwLnN0YXR1cyBOT1QgSU4gKCdvcGVuJykgQU5EIE5PVCAocC5zdGF0dXMgPSAnc29mdF9jbG9zZWQnIEFORCBqLmpvdXJuYWxfdHlwZSA9ICdhZGp1c3RtZW50JykgVEhFTgogICAgUkFJU0UgRVhDRVBUSU9OICdBY2NvdW50aW5nIHBlcmlvZCAlIGlzICUnLCBwLm5hbWUsIHAuc3RhdHVzOwogIEVORCBJRjsKCiAgSUYgai5qb3VybmFsX3R5cGUgPD4gJ3JldmVyc2FsJyBBTkQgai5zb3VyY2VfZG9jdW1lbnRfaWQgSVMgTk9UIE5VTEwgQU5EIEVYSVNUUyAoCiAgICAgIFNFTEVDVCAxIEZST00gcHVibGljLmpvdXJuYWxfZW50cmllcyB4CiAgICAgIFdIRVJFIHgub3JnYW5pemF0aW9uX2lkID0gai5vcmdhbml6YXRpb25faWQgQU5EIHguaWQgPD4gai5pZAogICAgICAgIEFORCB4LnNvdXJjZV9kb2N1bWVudF90eXBlID0gai5zb3VyY2VfZG9jdW1lbnRfdHlwZQogICAgICAgIEFORCB4LnNvdXJjZV9kb2N1bWVudF9pZCA9IGouc291cmNlX2RvY3VtZW50X2lkCiAgICAgICAgQU5EIHguc3RhdHVzID0gJ3Bvc3RlZCcgQU5EIHguam91cm5hbF90eXBlIDw+ICdyZXZlcnNhbCcKICAgICAgICBBTkQgeC5yZXZlcnNlZF9ieV9qb3VybmFsX2lkIElTIE5VTEwpIFRIRU4KICAgIFJBSVNFIEVYQ0VQVElPTiAnVGhpcyBzb3VyY2UgZG9jdW1lbnQgaGFzIGFscmVhZHkgYmVlbiBwb3N0ZWQnOwogIEVORCBJRjsKCiAgVVBEQVRFIHB1YmxpYy5qb3VybmFsX2VudHJpZXMKICAgIFNFVCBzdGF0dXM9J3Bvc3RlZCcsIHRvdGFsX2RlYml0PWQsIHRvdGFsX2NyZWRpdD1jLCBwZXJpb2RfaWQ9cC5pZCwKICAgICAgICBwb3N0ZWRfYnk9YXV0aC51aWQoKSwgcG9zdGVkX2F0PW5vdygpCiAgICBXSEVSRSBpZCA9IGouaWQ7CgogIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoJ29rJywgdHJ1ZSwgJ2pvdXJuYWxfaWQnLCBqLmlkLCAndG90YWwnLCBkLCAncGVyaW9kJywgcC5uYW1lKTsKRU5EICRmdW5jdGlvbiQKOwoKQ1JFQVRFIE9SIFJFUExBQ0UgRlVOQ1RJT04gcHVibGljLm5lb19nbF9wb3N0KF9vcmcgdXVpZCwgX2JyYW5jaCB1dWlkLCBfbW9kdWxlIHRleHQsIF9zb3VyY2VfdHlwZSB0ZXh0LCBfc291cmNlX2lkIHV1aWQsIF9wb3N0aW5nX3R5cGUgdGV4dCwgX2RhdGUgZGF0ZSwgX2N1cnJlbmN5IHRleHQsIF9kZXNjIHRleHQsIF9saW5lcyBqc29uYiwgX2N1c3RvbWVyIHV1aWQgREVGQVVMVCBOVUxMOjp1dWlkLCBfcmV2ZXJzZXMgdXVpZCBERUZBVUxUIE5VTEw6OnV1aWQpCiBSRVRVUk5TIGpzb25iCiBMQU5HVUFHRSBwbHBnc3FsCiBTRUNVUklUWSBERUZJTkVSCiBTRVQgc2VhcmNoX3BhdGggVE8gJ3B1YmxpYycKQVMgJGZ1bmN0aW9uJApERUNMQVJFIGtleSB0ZXh0IDo9IF9zb3VyY2VfdHlwZSB8fCAnOicgfHwgX3NvdXJjZV9pZDo6dGV4dCB8fCAnOicgfHwgX3Bvc3RpbmdfdHlwZTsKICAgICAgICBqIHV1aWQ7IGxuIGpzb25iOyBpIGludCA6PSAwOyB0ZCBudW1lcmljIDo9IDA7IHRjIG51bWVyaWMgOj0gMDsgYWNjdCB1dWlkOwogICAgICAgIGQgbnVtZXJpYzsgYyBudW1lcmljOyBwcmlvciB0ZXh0OyBleGlzdGluZyBwdWJsaWMuam91cm5hbF9lbnRyaWVzOwpCRUdJTgogICAgSUYgcHVibGljLmN1cnJlbnRfb3JnX2lkKCkgSVMgRElTVElOQ1QgRlJPTSBfb3JnIE9SIE5PVCBjb2FsZXNjZShwdWJsaWMubmVvX2JyYW5jaF9pbl9zY29wZShfYnJhbmNoKSxmYWxzZSkgVEhFTgogICAgICBSQUlTRSBFWENFUFRJT04gJ1Bvc3RpbmcgaXMgb3V0c2lkZSB0aGUgY3VycmVudCBvcmdhbml6YXRpb24gb3IgcHJvcGVydHkgc2NvcGUnIFVTSU5HIEVSUkNPREU9JzQyNTAxJzsKICAgIEVORCBJRjsKICAgIElGIF9zb3VyY2VfaWQgSVMgTlVMTCBPUiBudWxsaWYoYnRyaW0oX3NvdXJjZV90eXBlKSwnJykgSVMgTlVMTCBPUiBudWxsaWYoYnRyaW0oX3Bvc3RpbmdfdHlwZSksJycpIElTIE5VTEwgVEhFTgogICAgICBSQUlTRSBFWENFUFRJT04gJ1Bvc3Rpbmcgc291cmNlIGFuZCB0eXBlIGFyZSByZXF1aXJlZCcgVVNJTkcgRVJSQ09ERT0nMjIwMjMnOwogICAgRU5EIElGOwogICAgSUYgX2xpbmVzIElTIE5VTEwgT1IganNvbmJfdHlwZW9mKF9saW5lcyk8PidhcnJheScgVEhFTiBSQUlTRSBFWENFUFRJT04gJ1Bvc3RpbmcgbGluZXMgbXVzdCBiZSBhbiBhcnJheSc7IEVORCBJRjsKICAgIElGIGpzb25iX2FycmF5X2xlbmd0aChfbGluZXMpPTAgVEhFTiBSQUlTRSBFWENFUFRJT04gJ25vdGhpbmdfdG9fcG9zdCc7IEVORCBJRjsKICAgIEZPUiBsbiBJTiBTRUxFQ1QgKiBGUk9NIGpzb25iX2FycmF5X2VsZW1lbnRzKF9saW5lcykgTE9PUAogICAgICBkOj1jb2FsZXNjZSgobG4tPj4nZGViaXQnKTo6bnVtZXJpYywwKTtjOj1jb2FsZXNjZSgobG4tPj4nY3JlZGl0Jyk6Om51bWVyaWMsMCk7CiAgICAgIElGIGQ8MCBPUiBjPDAgT1IgZDo6dGV4dCBJTiAoJ05hTicsJ0luZmluaXR5JywnLUluZmluaXR5JykgT1IgYzo6dGV4dCBJTiAoJ05hTicsJ0luZmluaXR5JywnLUluZmluaXR5JykgT1IgKGQ+MCBBTkQgYz4wKSBUSEVOCiAgICAgICAgUkFJU0UgRVhDRVBUSU9OICdQb3N0aW5nIGFtb3VudHMgbXVzdCBiZSBmaW5pdGUgbm9ubmVnYXRpdmUgYW5kIG9uZS1zaWRlZCcgVVNJTkcgRVJSQ09ERT0nMjIwMjMnOwogICAgICBFTkQgSUY7CiAgICBFTkQgTE9PUDsKICAgIFBFUkZPUk0gcGdfYWR2aXNvcnlfeGFjdF9sb2NrKGhhc2h0ZXh0ZXh0ZW5kZWQoJ2dsOid8fF9vcmc6OnRleHR8fCc6J3x8a2V5LDApKTsKICBTRUxFQ1QgaWQgSU5UTyBqIEZST00gcHVibGljLmpvdXJuYWxfZW50cmllcwogICBXSEVSRSBvcmdhbml6YXRpb25faWQgPSBfb3JnCiAgICAgQU5EIChpZGVtcG90ZW5jeV9rZXkgPSBrZXkgT1IgbGVmdChpZGVtcG90ZW5jeV9rZXksbGVuZ3RoKGtleXx8Jzpjb3JyZWN0aW9uOicpKT1rZXl8fCc6Y29ycmVjdGlvbjonKQogICAgIEFORCByZXZlcnNlZF9ieV9qb3VybmFsX2lkIElTIE5VTEwKICAgT1JERVIgQlkgY3JlYXRlZF9hdCBERVNDIExJTUlUIDE7CiAgSUYgaiBJUyBOT1QgTlVMTCBUSEVOCiAgICAgIFNFTEVDVCAqIElOVE8gZXhpc3RpbmcgRlJPTSBwdWJsaWMuam91cm5hbF9lbnRyaWVzIFdIRVJFIGlkPWogRk9SIFVQREFURTsKICAgICAgSUYgZXhpc3RpbmcuYnJhbmNoX2lkIElTIERJU1RJTkNUIEZST00gX2JyYW5jaCBPUiBleGlzdGluZy5jdXJyZW5jeSBJUyBESVNUSU5DVCBGUk9NIGNvYWxlc2NlKF9jdXJyZW5jeSwnS0VTJykKICAgICAgICAgT1IgZXhpc3RpbmcuYWNjb3VudGluZ19kYXRlIElTIERJU1RJTkNUIEZST00gX2RhdGUKICAgICAgICAgT1IgZXhpc3Rpbmcuc291cmNlX2RvY3VtZW50X2lkIElTIERJU1RJTkNUIEZST00gX3NvdXJjZV9pZCBPUiBleGlzdGluZy5zb3VyY2VfZG9jdW1lbnRfdHlwZSBJUyBESVNUSU5DVCBGUk9NIF9zb3VyY2VfdHlwZXx8JzonfHxfcG9zdGluZ190eXBlIFRIRU4KICAgICAgICBSQUlTRSBFWENFUFRJT04gJ0V4aXN0aW5nIGpvdXJuYWwgc291cmNlLCBwcm9wZXJ0eSBvciBjdXJyZW5jeSBkaWZmZXJzJzsKICAgICAgRU5EIElGOwogICAgICBJRiBleGlzdGluZy5zdGF0dXMgSVMgTlVMTCBPUiBleGlzdGluZy5zdGF0dXMgTk9UIElOICgncG9zdGVkJywnZHJhZnQnLCdhcHByb3ZlZCcpIFRIRU4gUkFJU0UgRVhDRVBUSU9OICdFeGlzdGluZyBqb3VybmFsIGNhbm5vdCBiZSByZXVzZWQgZnJvbSBzdGF0dXMgJScsZXhpc3Rpbmcuc3RhdHVzOyBFTkQgSUY7CiAgICAgIFNFTEVDVCBjb2FsZXNjZShzdW0oZGViaXQpLDApLGNvYWxlc2NlKHN1bShjcmVkaXQpLDApIElOVE8gdGQsdGMgRlJPTSBwdWJsaWMuam91cm5hbF9lbnRyeV9saW5lcyBXSEVSRSBqb3VybmFsX2lkPWo7CiAgICAgIElGIHRkPD0wIE9SIHRkPD50YyBPUiB0ZDo6dGV4dCBJTiAoJ05hTicsJ0luZmluaXR5JywnLUluZmluaXR5JykgT1IgdGM6OnRleHQgSU4gKCdOYU4nLCdJbmZpbml0eScsJy1JbmZpbml0eScpCiAgICAgICAgIE9SIEVYSVNUUyhTRUxFQ1QgMSBGUk9NIHB1YmxpYy5qb3VybmFsX2VudHJ5X2xpbmVzIGwgTEVGVCBKT0lOIHB1YmxpYy5jaGFydF9vZl9hY2NvdW50cyBhIE9OIGEuaWQ9bC5hY2NvdW50X2lkCiAgICAgICAgICAgICBXSEVSRSBsLmpvdXJuYWxfaWQ9aiBBTkQgKGwub3JnYW5pemF0aW9uX2lkIElTIERJU1RJTkNUIEZST00gX29yZyBPUiBhLm9yZ2FuaXphdGlvbl9pZCBJUyBESVNUSU5DVCBGUk9NIF9vcmcKICAgICAgICAgICAgICAgT1IgbC5kZWJpdCBJUyBOVUxMIE9SIGwuY3JlZGl0IElTIE5VTEwgT1IgbC5kZWJpdDwwIE9SIGwuY3JlZGl0PDAgT1IgKGwuZGViaXQ+MCBBTkQgbC5jcmVkaXQ+MCkpKSBUSEVOCiAgICAgICAgUkFJU0UgRVhDRVBUSU9OICdFeGlzdGluZyBqb3VybmFsIGhhcyBpbnZhbGlkIG9yIHVuYmFsYW5jZWQgbGluZXMnOwogICAgICBFTkQgSUY7CiAgICAgIElGIGV4aXN0aW5nLnN0YXR1cz0ncG9zdGVkJyBUSEVOCiAgICAgICAgSUYgZXhpc3RpbmcudG90YWxfZGViaXQgSVMgRElTVElOQ1QgRlJPTSB0ZCBPUiBleGlzdGluZy50b3RhbF9jcmVkaXQgSVMgRElTVElOQ1QgRlJPTSB0YyBUSEVOIFJBSVNFIEVYQ0VQVElPTiAnUG9zdGVkIGpvdXJuYWwgdG90YWxzIGRpc2FncmVlIHdpdGggaXRzIGxpbmVzJzsgRU5EIElGOwogICAgICBFTFNFCiAgICAgICAgSUYgRVhJU1RTKFdJVEggd2FudGVkIEFTICgKICAgICAgICAgIFNFTEVDVCByZXF1ZXN0ZWQudmFsdWUtPj4nY29kZScgQVMgY29kZSxzdW0ocm91bmQoY29hbGVzY2UoKHJlcXVlc3RlZC52YWx1ZS0+PidkZWJpdCcpOjpudW1lcmljLDApLDIpKSBBUyBkLHN1bShyb3VuZChjb2FsZXNjZSgocmVxdWVzdGVkLnZhbHVlLT4+J2NyZWRpdCcpOjpudW1lcmljLDApLDIpKSBBUyBjCiAgICAgICAgICBGUk9NIGpzb25iX2FycmF5X2VsZW1lbnRzKF9saW5lcykgQVMgcmVxdWVzdGVkKHZhbHVlKSBHUk9VUCBCWSAxCiAgICAgICAgKSwgYWN0dWFsIEFTICgKICAgICAgICAgIFNFTEVDVCBhLmNvZGUsc3VtKGwuZGViaXQpIEFTIGQsc3VtKGwuY3JlZGl0KSBBUyBjIEZST00gcHVibGljLmpvdXJuYWxfZW50cnlfbGluZXMgbCBKT0lOIHB1YmxpYy5jaGFydF9vZl9hY2NvdW50cyBhIE9OIGEuaWQ9bC5hY2NvdW50X2lkCiAgICAgICAgICBXSEVSRSBsLmpvdXJuYWxfaWQ9aiBHUk9VUCBCWSBhLmNvZGUKICAgICAgICApIFNFTEVDVCAxIEZST00gd2FudGVkIHcgRlVMTCBKT0lOIGFjdHVhbCBhIE9OIGEuY29kZT13LmNvZGUKICAgICAgICAgIFdIRVJFIGNvYWxlc2NlKHcuZCwwKTw+Y29hbGVzY2UoYS5kLDApIE9SIGNvYWxlc2NlKHcuYywwKTw+Y29hbGVzY2UoYS5jLDApKSBUSEVOCiAgICAgICAgICBSQUlTRSBFWENFUFRJT04gJ0V4aXN0aW5nIGRyYWZ0IGxpbmVzIGRpZmZlciBmcm9tIHRoZSByZXF1ZXN0ZWQgcG9zdGluZyc7CiAgICAgICAgRU5EIElGOwogICAgICAgIHByaW9yOj1jb2FsZXNjZShjdXJyZW50X3NldHRpbmcoJ25lby5zeXN0ZW1fcG9zdGluZycsdHJ1ZSksJ29mZicpOwogICAgICAgIEJFR0lOCiAgICAgICAgICBQRVJGT1JNIHNldF9jb25maWcoJ25lby5zeXN0ZW1fcG9zdGluZycsJ29uJyx0cnVlKTsKICAgICAgICAgIFBFUkZPUk0gcHVibGljLmZpbl9wb3N0X2pvdXJuYWwoaik7CiAgICAgICAgICBQRVJGT1JNIHNldF9jb25maWcoJ25lby5zeXN0ZW1fcG9zdGluZycscHJpb3IsdHJ1ZSk7CiAgICAgICAgRVhDRVBUSU9OIFdIRU4gT1RIRVJTIFRIRU4KICAgICAgICAgIFBFUkZPUk0gc2V0X2NvbmZpZygnbmVvLnN5c3RlbV9wb3N0aW5nJyxwcmlvcix0cnVlKTtSQUlTRTsKICAgICAgICBFTkQ7CiAgICAgICAgSUYgTk9UIEVYSVNUUyhTRUxFQ1QgMSBGUk9NIHB1YmxpYy5qb3VybmFsX2VudHJpZXMgV0hFUkUgaWQ9aiBBTkQgc3RhdHVzPSdwb3N0ZWQnKSBUSEVOIFJBSVNFIEVYQ0VQVElPTiAnRXhpc3Rpbmcgam91cm5hbCBkaWQgbm90IHJlYWNoIHBvc3RlZCBzdGF0dXMnOyBFTkQgSUY7CiAgICAgIEVORCBJRjsKICAgIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoJ29rJywgdHJ1ZSwgJ2pvdXJuYWxfaWQnLCBqLCAnZHVwbGljYXRlX3ByZXZlbnRlZCcsIHRydWUpOwogIEVORCBJRjsKICBJRiBFWElTVFMgKFNFTEVDVCAxIEZST00gcHVibGljLmpvdXJuYWxfZW50cmllcwogICAgICAgICAgICAgV0hFUkUgb3JnYW5pemF0aW9uX2lkID0gX29yZyBBTkQgaWRlbXBvdGVuY3lfa2V5ID0ga2V5CiAgICAgICAgICAgICAgIEFORCByZXZlcnNlZF9ieV9qb3VybmFsX2lkIElTIE5PVCBOVUxMKSBUSEVOCiAgICBrZXkgOj0ga2V5IHx8ICc6Y29ycmVjdGlvbjonIHx8ICgxICsgKFNFTEVDVCBjb3VudCgqKSBGUk9NIHB1YmxpYy5qb3VybmFsX2VudHJpZXMKICAgICAgV0hFUkUgb3JnYW5pemF0aW9uX2lkID0gX29yZyBBTkQgbGVmdChpZGVtcG90ZW5jeV9rZXksbGVuZ3RoKGtleXx8Jzpjb3JyZWN0aW9uOicpKT1rZXl8fCc6Y29ycmVjdGlvbjonKSk6OnRleHQ7CiAgRU5EIElGOwoKICBJTlNFUlQgSU5UTyBwdWJsaWMuam91cm5hbF9lbnRyaWVzCiAgICAob3JnYW5pemF0aW9uX2lkLCBicmFuY2hfaWQsIGpvdXJuYWxfbnVtYmVyLCBqb3VybmFsX3R5cGUsIGFjY291bnRpbmdfZGF0ZSwKICAgICBwZXJpb2RfaWQsIHNvdXJjZV9tb2R1bGUsIHNvdXJjZV9kb2N1bWVudF90eXBlLCBzb3VyY2VfZG9jdW1lbnRfaWQsCiAgICAgaWRlbXBvdGVuY3lfa2V5LCBkZXNjcmlwdGlvbiwgY3VycmVuY3ksIHN0YXR1cywgY3JlYXRlZF9ieSwgcmV2ZXJzZXNfam91cm5hbF9pZCkKICBWQUxVRVMgKF9vcmcsIF9icmFuY2gsIHB1YmxpYy5uZXh0X2RvY3VtZW50X251bWJlcignam91cm5hbCcsJ0pWJyxfYnJhbmNoKSwKICAgICAgICAgIENBU0UgV0hFTiBfcmV2ZXJzZXMgSVMgTlVMTCBUSEVOICdhdXRvbWF0aWMnIEVMU0UgJ3JldmVyc2FsJyBFTkQsIF9kYXRlLAogICAgICAgICAgcHVibGljLm5lb19nbF9wZXJpb2QoX29yZywgX2RhdGUpLCBfbW9kdWxlLAogICAgICAgICAgX3NvdXJjZV90eXBlIHx8ICc6JyB8fCBfcG9zdGluZ190eXBlLCBfc291cmNlX2lkLCBrZXksIF9kZXNjLAogICAgICAgICAgY29hbGVzY2UoX2N1cnJlbmN5LCdLRVMnKSwgJ2RyYWZ0JywgYXV0aC51aWQoKSwgX3JldmVyc2VzKQogIFJFVFVSTklORyBpZCBJTlRPIGo7CgogIEZPUiBsbiBJTiBTRUxFQ1QgKiBGUk9NIGpzb25iX2FycmF5X2VsZW1lbnRzKF9saW5lcykgTE9PUAogICAgZCA6PSByb3VuZChjb2FsZXNjZSgobG4tPj4nZGViaXQnKTo6bnVtZXJpYywgMCksIDIpOwogICAgYyA6PSByb3VuZChjb2FsZXNjZSgobG4tPj4nY3JlZGl0Jyk6Om51bWVyaWMsIDApLCAyKTsKICAgIENPTlRJTlVFIFdIRU4gZCA9IDAgQU5EIGMgPSAwOwogICAgYWNjdCA6PSBwdWJsaWMubmVvX2dsX2FjY3QoX29yZywgbG4tPj4nY29kZScpOwogICAgSUYgYWNjdCBJUyBOVUxMIFRIRU4KICAgICAgUkFJU0UgRVhDRVBUSU9OICdjaGFydF9vZl9hY2NvdW50cyBpcyBtaXNzaW5nIHBvc3RhYmxlIGFjY291bnQgJScsIGxuLT4+J2NvZGUnOwogICAgRU5EIElGOwogICAgaSA6PSBpICsgMTsKICAgIElOU0VSVCBJTlRPIHB1YmxpYy5qb3VybmFsX2VudHJ5X2xpbmVzCiAgICAgIChvcmdhbml6YXRpb25faWQsIGpvdXJuYWxfaWQsIGxpbmVfbnVtYmVyLCBhY2NvdW50X2lkLCBkZXNjcmlwdGlvbiwgZGViaXQsIGNyZWRpdCwKICAgICAgIGJyYW5jaF9pZCwgY3VzdG9tZXJfaWQpCiAgICBWQUxVRVMgKF9vcmcsIGosIGksIGFjY3QsIGNvYWxlc2NlKGxuLT4+J2Rlc2NyaXB0aW9uJywgX2Rlc2MpLCBkLCBjLCBfYnJhbmNoLCBfY3VzdG9tZXIpOwogICAgdGQgOj0gdGQgKyBkOyB0YyA6PSB0YyArIGM7CiAgRU5EIExPT1A7CgogIElGIGkgPSAwIFRIRU4gUkFJU0UgRVhDRVBUSU9OICdub3RoaW5nX3RvX3Bvc3QnOyBFTkQgSUY7CiAgSUYgcm91bmQodGQsMikgPD4gcm91bmQodGMsMikgVEhFTgogICAgUkFJU0UgRVhDRVBUSU9OICdKb3VybmFsIGRvZXMgbm90IGJhbGFuY2U6IGRlYml0cyAlIHZzIGNyZWRpdHMgJScsIHRkLCB0YzsKICBFTkQgSUY7CgogIFVQREFURSBwdWJsaWMuam91cm5hbF9lbnRyaWVzCiAgICAgU0VUIHRvdGFsX2RlYml0ID0gcm91bmQodGQsMiksIHRvdGFsX2NyZWRpdCA9IHJvdW5kKHRjLDIpCiAgIFdIRVJFIGlkID0gajsKCiAgLS0gQXV0b21hdGljIG1vZHVsZSBwb3N0aW5ncyBhcmUgc3lzdGVtIHBvc3RpbmdzOiB0aGUgb3BlcmF0aW9uYWwgYXV0aG9yaXR5IHdhcwogIC0tIGFscmVhZHkgdmVyaWZpZWQgdXBzdHJlYW0sIHNvIHRoZSBjYWxsZXIgZG9lcyBub3QgbmVlZCBtYW51YWwgam91cm5hbCByaWdodHMuCiAgcHJpb3IgOj0gY29hbGVzY2UoY3VycmVudF9zZXR0aW5nKCduZW8uc3lzdGVtX3Bvc3RpbmcnLCB0cnVlKSwgJ29mZicpOwogIFBFUkZPUk0gc2V0X2NvbmZpZygnbmVvLnN5c3RlbV9wb3N0aW5nJywgJ29uJywgdHJ1ZSk7CiAgUEVSRk9STSBwdWJsaWMuZmluX3Bvc3Rfam91cm5hbChqKTsKICBQRVJGT1JNIHNldF9jb25maWcoJ25lby5zeXN0ZW1fcG9zdGluZycsIHByaW9yLCB0cnVlKTsKICBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KCdvaycsIHRydWUsICdqb3VybmFsX2lkJywgaiwgJ2R1cGxpY2F0ZV9wcmV2ZW50ZWQnLCBmYWxzZSk7CkVORDsKJGZ1bmN0aW9uJAo7Cg==",
  "base64"
).toString("utf8");

describe("canonical accommodation Finance journal execution", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();

    await db.exec(`
      CREATE SCHEMA auth;

      CREATE FUNCTION auth.uid()
      RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(
          current_setting('test.actor',true),''
        )::uuid
      $$;

      CREATE FUNCTION public.current_org_id()
      RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT '${org}'::uuid
      $$;

      CREATE FUNCTION public.current_access_scope()
      RETURNS text LANGUAGE sql STABLE AS $$
        SELECT 'branch'::text
      $$;

      CREATE FUNCTION public.neo_branch_in_scope(uuid)
      RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT $1='${branch}'::uuid
      $$;

      CREATE FUNCTION public.neo_system_posting()
      RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT coalesce(
          current_setting('neo.system_posting',true),
          'off'
        )='on'
      $$;

      CREATE FUNCTION public.has_permission(text,text)
      RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT false
      $$;

      CREATE FUNCTION public.is_org_admin()
      RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT false
      $$;

      CREATE TABLE public.accounting_periods (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        name text NOT NULL,
        status text NOT NULL
      );

      CREATE TABLE public.chart_of_accounts (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        code text NOT NULL,
        active boolean DEFAULT true,
        postable boolean DEFAULT true,
        is_header boolean DEFAULT false,
        UNIQUE(organization_id,code)
      );

      CREATE TABLE public.journal_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        branch_id uuid,
        journal_number text,
        journal_type text,
        accounting_date date,
        period_id uuid,
        source_module text,
        source_document_type text,
        source_document_id uuid,
        idempotency_key text,
        description text,
        currency text,
        status text,
        created_by uuid,
        posted_by uuid,
        posted_at timestamptz,
        created_at timestamptz DEFAULT now(),
        reverses_journal_id uuid,
        reversed_by_journal_id uuid,
        total_debit numeric DEFAULT 0,
        total_credit numeric DEFAULT 0,
        UNIQUE(organization_id,idempotency_key)
      );

      CREATE TABLE public.journal_entry_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        journal_id uuid REFERENCES public.journal_entries(id),
        line_number integer,
        account_id uuid REFERENCES public.chart_of_accounts(id),
        description text,
        debit numeric,
        credit numeric,
        branch_id uuid,
        customer_id uuid
      );

      CREATE FUNCTION public.neo_gl_acct(
        _org uuid,_code text
      )
      RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT id
        FROM public.chart_of_accounts
        WHERE organization_id=_org
          AND code=_code
          AND active
          AND postable
          AND NOT is_header
      $$;

      CREATE FUNCTION public.neo_gl_period(
        _org uuid,_date date
      )
      RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT id
        FROM public.accounting_periods
        WHERE organization_id=_org
        LIMIT 1
      $$;

      CREATE FUNCTION public.fin_period_for(
        _org uuid,_date date
      )
      RETURNS SETOF public.accounting_periods
      LANGUAGE sql STABLE AS $$
        SELECT *
        FROM public.accounting_periods
        WHERE organization_id=_org
        LIMIT 1
      $$;

      CREATE FUNCTION public.next_document_number(
        text,text,uuid
      )
      RETURNS text LANGUAGE sql AS $$
        SELECT 'JV-'||gen_random_uuid()::text
      $$;
    `);

    // Execute the exported canonical journal functions,
    // not substitute posting implementations.

    await db.exec(canonicalSQL);
  },60000);

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE
        public.journal_entry_lines,
        public.journal_entries,
        public.chart_of_accounts,
        public.accounting_periods;

      SELECT
        set_config('test.actor','${actor}',false),
        set_config('neo.system_posting','off',false);

      INSERT INTO public.accounting_periods
      VALUES (
        '${period}','${org}',
        'Test accounting period','open'
      );

      INSERT INTO public.chart_of_accounts
        (id,organization_id,code)
      VALUES
        ('${cash}','${org}','1010'),
        ('${liability}','${org}','2020'),
        ('${receivable}','${org}','1060'),
        ('${revenue}','${org}','4010');
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  type JournalLine = {
    code: string;
    debit?: number;
    credit?: number;
  };

  async function post(
    source: string,
    sourceId: string,
    postingType: string,
    lines: JournalLine[],
    property = branch
  ) {
    const result = await db.query<{
      result: {
        ok: boolean;
        journal_id: string;
        duplicate_prevented: boolean;
      };
    }>(
      `SELECT public.neo_gl_post(
        $1,$2,'pms',$3,$4,$5,
        current_date,'KES',
        'Accommodation acceptance fixture',
        $6::jsonb,NULL,NULL
      ) AS result`,
      [
        org,
        property,
        source,
        sourceId,
        postingType,
        JSON.stringify(lines)
      ]
    );

    return result.rows[0]!.result;
  }

  async function accountBalance(code: string) {
    const result = await db.query<{
      balance: number;
    }>(
      `SELECT coalesce(
         sum(l.debit-l.credit),0
       )::float8 AS balance
       FROM public.journal_entry_lines l
       JOIN public.chart_of_accounts a
         ON a.id=l.account_id
       JOIN public.journal_entries j
         ON j.id=l.journal_id
       WHERE a.code=$1
         AND a.organization_id=$2
         AND j.status='posted'
         AND j.reversed_by_journal_id IS NULL`,
      [code,org]
    );

    return result.rows[0]!.balance;
  }

  async function journalCount() {
    const result = await db.query<{ n: number }>(`
      SELECT count(*)::integer AS n
      FROM public.journal_entries
    `);

    return result.rows[0]!.n;
  }

  async function deposit(amount = 50000) {
    return post(
      "reservation_deposit",
      id(1250),
      "deposit",
      [
        {code:"1010",debit:amount},
        {code:"2020",credit:amount}
      ]
    );
  }

  async function accommodation(n: number,amount = 19000) {
    return post(
      "folio_charge",
      id(1260+n),
      "revenue",
      [
        {code:"1060",debit:amount},
        {code:"4010",credit:amount}
      ]
    );
  }

  async function application(n: number,amount: number) {
    return post(
      "reservation_deposit_allocation",
      id(1270+n),
      "application",
      [
        {code:"2020",debit:amount},
        {code:"1060",credit:amount}
      ]
    );
  }

  it("posts original guest deposits as liabilities rather than revenue", async () => {
    expect(await deposit()).toMatchObject({
      ok:true,
      duplicate_prevented:false
    });

    expect(await accountBalance("1010")).toBe(50000);
    expect(await accountBalance("2020")).toBe(-50000);
    expect(await accountBalance("4010")).toBe(0);
    expect(await accountBalance("1060")).toBe(0);
  });

  it("posts the first night and releases only earned deposit liability", async () => {
    await deposit();
    await accommodation(1);
    await application(1,19000);

    expect(await accountBalance("2020")).toBe(-31000);
    expect(await accountBalance("1060")).toBe(0);
    expect(await accountBalance("4010")).toBe(-19000);
    expect(await accountBalance("1010")).toBe(50000);
  });

  it("reconciles the complete three-night accounting scenario", async () => {
    await deposit();

    await accommodation(1);
    await application(1,19000);

    expect(await accountBalance("2020")).toBe(-31000);

    await accommodation(2);
    await application(2,19000);

    expect(await accountBalance("2020")).toBe(-12000);

    await accommodation(3);
    await application(3,12000);

    expect(await accountBalance("2020")).toBe(0);
    expect(await accountBalance("1060")).toBe(7000);
    expect(await accountBalance("4010")).toBe(-57000);
    expect(await accountBalance("1010")).toBe(50000);

    expect(await journalCount()).toBe(7);
  });

  it("reconciles final restaurant charges and checkout collection", async () => {
    await deposit();

    await accommodation(1);
    await application(1,19000);

    await accommodation(2);
    await application(2,19000);

    await accommodation(3);
    await application(3,12000);

    await post(
      "folio_charge",
      id(1280),
      "revenue",
      [
        {code:"1060",debit:3000},
        {code:"4010",credit:3000}
      ]
    );

    expect(await accountBalance("1060")).toBe(10000);

    await post(
      "folio_payment",
      id(1281),
      "collection",
      [
        {code:"1010",debit:10000},
        {code:"1060",credit:10000}
      ]
    );

    expect(await accountBalance("2020")).toBe(0);
    expect(await accountBalance("1060")).toBe(0);
    expect(await accountBalance("4010")).toBe(-60000);
    expect(await accountBalance("1010")).toBe(60000);
  });

  it("refunds unused liability without reversing earned accommodation", async () => {
    await deposit();
    await accommodation(1);
    await application(1,19000);

    await post(
      "cash_refund",
      id(1282),
      "refund",
      [
        {code:"2020",debit:10000},
        {code:"1010",credit:10000}
      ]
    );

    expect(await accountBalance("2020")).toBe(-21000);
    expect(await accountBalance("1060")).toBe(0);
    expect(await accountBalance("4010")).toBe(-19000);
    expect(await accountBalance("1010")).toBe(40000);
  });

  it("reuses canonical journal evidence on exact replay", async () => {
    const first = await deposit();
    const second = await deposit();

    expect(second).toMatchObject({
      ok:true,
      journal_id:first.journal_id,
      duplicate_prevented:true
    });

    expect(await journalCount()).toBe(1);
    expect(await accountBalance("2020")).toBe(-50000);
  });

  it("rejects posting outside the authorized property", async () => {
    await expect(
      post(
        "folio_charge",
        id(1283),
        "revenue",
        [
          {code:"1060",debit:19000},
          {code:"4010",credit:19000}
        ],
        otherBranch
      )
    ).rejects.toThrow(/scope/i);

    expect(await journalCount()).toBe(0);
  });

  it("rolls back unbalanced journal transactions", async () => {
    await expect(
      post(
        "folio_charge",
        id(1284),
        "revenue",
        [
          {code:"1060",debit:19000},
          {code:"4010",credit:18000}
        ]
      )
    ).rejects.toThrow(/balance/i);

    expect(await journalCount()).toBe(0);
  });

  it("rejects negative journal components", async () => {
    await expect(
      post(
        "folio_charge",
        id(1285),
        "revenue",
        [
          {code:"1060",debit:-19000},
          {code:"4010",credit:-19000}
        ]
      )
    ).rejects.toThrow(/nonnegative/i);

    expect(await journalCount()).toBe(0);
  });

  it("rejects closed accounting periods atomically", async () => {
    await db.exec(`
      UPDATE public.accounting_periods
      SET status='closed'
    `);

    await expect(deposit()).rejects.toThrow(
      /accounting period.*closed/i
    );

    expect(await journalCount()).toBe(0);
  });

  it("rejects inactive posting accounts atomically", async () => {
    await db.exec(`
      UPDATE public.chart_of_accounts
      SET active=false
      WHERE code='2020'
    `);

    await expect(deposit()).rejects.toThrow(
      /missing postable account/i
    );

    expect(await journalCount()).toBe(0);
  });

  it("supports unattended system journal attribution", async () => {
    await db.exec(`
      SELECT set_config('test.actor','',false)
    `);

    const result = await deposit();

    const journal = await db.query<{
      status: string;
      created_by: string | null;
      posted_by: string | null;
    }>(
      `SELECT status,created_by,posted_by
       FROM public.journal_entries
       WHERE id=$1`,
      [result.journal_id]
    );

    expect(journal.rows[0]).toEqual({
      status:"posted",
      created_by:null,
      posted_by:null
    });
  });

  it("restores system posting context after canonical journal execution", async () => {
    await db.exec("BEGIN");

    try {
      await deposit();

      const result = await db.query<{
        enabled: boolean;
      }>(`
        SELECT public.neo_system_posting()
        AS enabled
      `);

      expect(result.rows[0]!.enabled).toBe(false);
    } finally {
      await db.exec("ROLLBACK");
    }
  });

  it("rolls back revenue and allocation together after a failed accounting transaction", async () => {
    await deposit();

    await db.exec("BEGIN");

    try {
      await accommodation(1);

      await db.exec(`
        UPDATE public.chart_of_accounts
        SET active=false
        WHERE code='2020'
      `);

      await expect(
        application(1,19000)
      ).rejects.toThrow(/postable account/i);
    } finally {
      await db.exec("ROLLBACK");
    }

    expect(await journalCount()).toBe(1);
    expect(await accountBalance("2020")).toBe(-50000);
    expect(await accountBalance("4010")).toBe(0);
    expect(await accountBalance("1060")).toBe(0);
  });
});
