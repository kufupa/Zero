"""Run fake-only wrapper in a kernel-enforced no-Internet sandbox."""
from __future__ import annotations
import ctypes,ctypes.util,errno,json,os,runpy,socket,sys
from pathlib import Path

def install_no_inet_sockets():
 lib=ctypes.CDLL(ctypes.util.find_library("seccomp"),use_errno=True)
 lib.seccomp_init.argtypes=[ctypes.c_uint32];lib.seccomp_init.restype=ctypes.c_void_p
 lib.seccomp_syscall_resolve_name.argtypes=[ctypes.c_char_p];lib.seccomp_syscall_resolve_name.restype=ctypes.c_int
 lib.seccomp_rule_add_array.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_int,ctypes.c_uint,ctypes.c_void_p];lib.seccomp_rule_add_array.restype=ctypes.c_int
 lib.seccomp_load.argtypes=[ctypes.c_void_p];lib.seccomp_load.restype=ctypes.c_int;lib.seccomp_release.argtypes=[ctypes.c_void_p]
 class ArgCmp(ctypes.Structure):_fields_=[("arg",ctypes.c_uint),("op",ctypes.c_int),("datum_a",ctypes.c_uint64),("datum_b",ctypes.c_uint64)]
 ctx=lib.seccomp_init(0x7fff0000)
 if not ctx:raise SystemExit("seccomp init failed")
 deny=0x00050000|errno.EPERM
 for call in (b"socket",b"socketpair"):
  num=lib.seccomp_syscall_resolve_name(call)
  for family in (socket.AF_INET,socket.AF_INET6):
   cmp=ArgCmp(0,4,family,0)
   if lib.seccomp_rule_add_array(ctx,deny,num,1,ctypes.byref(cmp))!=0:lib.seccomp_release(ctx);raise SystemExit("seccomp rule failed")
 if lib.seccomp_load(ctx)!=0:lib.seccomp_release(ctx);raise SystemExit("seccomp load failed")
 lib.seccomp_release(ctx)
try:install_no_inet_sockets()
except (OSError,AttributeError,TypeError) as exc:raise SystemExit("no-egress sandbox unavailable; refusing") from exc
try:socket.socket(socket.AF_INET,socket.SOCK_STREAM)
except OSError:pass
else:raise SystemExit("Internet socket remains available")
root=Path(__file__).resolve().parent;sys.path.insert(0,str(root))
target=Path(sys.argv[1]).resolve()
if target.parent!=root or target.name not in {"fake_client.py","server.py"}:raise SystemExit("sandbox target denied")
runpy.run_path(str(target),run_name="__main__")
