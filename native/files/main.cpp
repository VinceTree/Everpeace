#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <bcrypt.h>
#include <aclapi.h>
#include <sddl.h>
#include <fcntl.h>
#include <io.h>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>
#include <stdexcept>
#include <memory>
// EPF2: bounded length-prefixed UTF-8 paths, workspace identity and raw bytes.
static constexpr uint32_t LIMIT = 64 * 1024 * 1024;
struct Failure  {
  uint32_t code;
};
struct Handle  {
  bool eraseOnClose=false;
  HANDLE h = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE v):h(v) {
  } ~Handle() {
    if(h != INVALID_HANDLE_VALUE) {
      if(eraseOnClose) {
        FILE_DISPOSITION_INFO d {
          TRUE
        };
        SetFileInformationByHandle(h,FileDispositionInfo,&d,sizeof d);
      }CloseHandle(h);
    }
  }
};
using Held = std::unique_ptr<Handle>;
static Held hold(HANDLE h)  {
  if(h == INVALID_HANDLE_VALUE) throw Failure {
    GetLastError()==ERROR_SHARING_VIOLATION ? 3u : 4u
  };
  return std::make_unique<Handle>(h);
}
static void exact(void* p, size_t n)  {
  if(fread(p,1,n,stdin)!=n) throw Failure {
    4
  };
}
static uint32_t number() {
  uint32_t n;
  exact(&n,4);
  return n;
}
static std::string field() {
  uint32_t n=number();
  if(n>LIMIT) throw Failure {
    4
  };
  std::string s(n,'\0');
  if(n) exact(s.data(),n);
  return s;
}
static void out(uint32_t n) {
  fwrite(&n,4,1,stdout);
}
static void blob(const std::string& s) {
  out(static_cast<uint32_t>(s.size()));
  fwrite(s.data(),1,s.size(),stdout);
}
static std::string encoded(const std::string& s) {
  uint32_t n=static_cast<uint32_t>(s.size());
  return std::string(reinterpret_cast<char*>(&n),4)+s;
}
static std::wstring wide(const std::string& s)  {
  if(s.empty())return L"";
  if(s.find('\0')!=std::string::npos) throw Failure {
    4
  };
  int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),static_cast<int>(s.size()),nullptr,0);
  if(!n) throw Failure {
    4
  };
  std::wstring w(n,L'\0');
  MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),static_cast<int>(s.size()),w.data(),n);
  return w;
}
static std::string narrow(const std::wstring& s) {
  int n=WideCharToMultiByte(CP_UTF8,0,s.data(),static_cast<int>(s.size()),nullptr,0,nullptr,nullptr);
  std::string v(n,'\0');
  WideCharToMultiByte(CP_UTF8,0,s.data(),static_cast<int>(s.size()),v.data(),n,nullptr,nullptr);
  return v;
}
static BY_HANDLE_FILE_INFORMATION info(HANDLE h) {
  BY_HANDLE_FILE_INFORMATION i {
  };
  if(!GetFileInformationByHandle(h,&i)) throw Failure {
    4
  };
  if(i.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) throw Failure {
    4
  };
  return i;
}
static std::string identity(HANDLE h) {
  auto i=info(h);
  return std::to_string(i.dwVolumeSerialNumber)+":"+std::to_string(i.nFileIndexHigh)+":"+std::to_string(i.nFileIndexLow);
}
static std::string read(HANDLE h) {
  auto i=info(h);
  if((i.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)||i.nNumberOfLinks!=1||i.nFileSizeHigh) throw Failure {
    4
  };
  if(i.nFileSizeLow>LIMIT)throw Failure {
    7
  };
  std::string s(i.nFileSizeLow,'\0');
  DWORD n=0;
  if(!s.empty()&&(!ReadFile(h,s.data(),static_cast<DWORD>(s.size()),&n,nullptr)||n!=s.size()))throw Failure {
    4
  };
  return s;
}
static void write(HANDLE h,const std::string& s) {
  DWORD n=0;
  if((!s.empty()&&(!WriteFile(h,s.data(),static_cast<DWORD>(s.size()),&n,nullptr)||n!=s.size()))||!FlushFileBuffers(h))throw Failure {
    4
  };
}
static std::wstring id() {
  unsigned char b[16];
  if(BCryptGenRandom(nullptr,b,sizeof b,BCRYPT_USE_SYSTEM_PREFERRED_RNG)!=0)throw Failure {
    4
  };
  const wchar_t* hex=L"0123456789abcdef";
  std::wstring s;
  for(auto c:b) {
    s+=hex[c>>4];
    s+=hex[c&15];
  }return s;
}
static HANDLE relativeOpen(HANDLE parent, const std::wstring& name, DWORD access, DWORD sharing, bool directory, bool create=false)  {
  if(name.empty() || name.size()>255 || name==L"." || name==L"..") {SetLastError(ERROR_INVALID_NAME);return INVALID_HANDLE_VALUE;}
  using Open = NTSTATUS (NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,PIO_STATUS_BLOCK,PLARGE_INTEGER,ULONG,ULONG,ULONG,ULONG,PVOID,ULONG);
  auto call=reinterpret_cast<Open>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtCreateFile"));
  UNICODE_STRING text {
  };
  text.Buffer=const_cast<PWSTR>(name.data());
  text.Length=static_cast<USHORT>(name.size()*2);
  text.MaximumLength=text.Length;
  OBJECT_ATTRIBUTES attributes {
  };
  InitializeObjectAttributes(&attributes,&text,OBJ_CASE_INSENSITIVE,parent,nullptr);
  IO_STATUS_BLOCK io {
  };
  HANDLE h;
  NTSTATUS status=call(&h,access|SYNCHRONIZE,&attributes,&io,nullptr,FILE_ATTRIBUTE_NORMAL,sharing,create?2:1,0x00200000|0x20|(directory?1:0x40),nullptr,0);
  if(status<0) {
    using Convert=ULONG (WINAPI*)(NTSTATUS);
    auto convert=reinterpret_cast<Convert>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"RtlNtStatusToDosError"));
    SetLastError(convert(status));
    return INVALID_HANDLE_VALUE;
  }return h;
}
static void renameHandle(HANDLE h,const std::wstring& to,HANDLE parent) {
  auto name=to.substr(to.find_last_of(L'\\')+1);
  std::vector<unsigned char>b(sizeof(FILE_RENAME_INFO)+name.size()*2);
  auto r=reinterpret_cast<FILE_RENAME_INFO*>(b.data());
  r->ReplaceIfExists=FALSE;
  r->RootDirectory=parent;
  r->FileNameLength=static_cast<DWORD>(name.size()*2);
  memcpy(r->FileName,name.data(),r->FileNameLength);
  using Set=NTSTATUS (NTAPI*)(HANDLE,PIO_STATUS_BLOCK,PVOID,ULONG,ULONG);
  auto call=reinterpret_cast<Set>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtSetInformationFile"));
  IO_STATUS_BLOCK io {
  };
  NTSTATUS status=call(h,&io,r,static_cast<ULONG>(b.size()),10);
  if(status<0)throw Failure {
    5
  };
}
static void removeHandle(HANDLE h) {
  FILE_DISPOSITION_INFO d {
    TRUE
  };
  if(!SetFileInformationByHandle(h,FileDispositionInfo,&d,sizeof d))throw Failure {
    4
  };
}
static void privateAcl(HANDLE h) {
  HANDLE token;
  if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token))throw Failure {
    4
  };
  Handle t(token);
  DWORD n=0;
  GetTokenInformation(token,TokenUser,nullptr,0,&n);
  std::vector<unsigned char>b(n);
  if(!GetTokenInformation(token,TokenUser,b.data(),n,&n))throw Failure {
    4
  };
  LPWSTR sid=nullptr;
  if(!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(b.data())->User.Sid,&sid))throw Failure {
    4
  };
  std::wstring s=L"D:P(A;;FA;;;"+std::wstring(sid)+L")";
  LocalFree(sid);
  PSECURITY_DESCRIPTOR sd=nullptr;
  if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(s.c_str(),SDDL_REVISION_1,&sd,nullptr))throw Failure {
    4
  };
  BOOL present,def;
  PACL acl;
  GetSecurityDescriptorDacl(sd,&present,&acl,&def);
  DWORD e=SetSecurityInfo(h,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,nullptr,nullptr,acl,nullptr);
  LocalFree(sd);
  if(e!=ERROR_SUCCESS)throw Failure {
    4
  };
}
#ifdef EP_FILE_TEST
static void point(const char* name) {
  fprintf(stderr,"PHASE:%s\n",name);
  fflush(stderr);
  int instruction=getchar();
  if(instruction=='!') {SetLastError(ERROR_DISK_FULL);throw Failure {4};}
  if(instruction==EOF)throw Failure {
    4
  };
}
#else
static void point(const char*) {
}
#endif
int main() {
  _setmode(_fileno(stdin),_O_BINARY);
  _setmode(_fileno(stdout),_O_BINARY);
  std::string recovery;
  try {
    char magic[4];
    exact(magic,4);
    bool version3=!memcmp(magic,"EPF3",4);
    if(!version3&&memcmp(magic,"EPF2",4))throw Failure {
      4
    };
    uint32_t op=number();
    auto root=wide(field());
    auto relative=wide(field());
    auto expectedRoot=field();
    auto expectedTarget=field();
    auto before=field();
    auto after=field();
    uint32_t exists=number();
    uint32_t restoreAttributes=number();
    auto retained=version3?field():std::string();
    if(!retained.empty()) {
      if(retained.size()!=32)throw Failure {4};
      for(auto c:retained)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))throw Failure {4};
      if(op==0||op==4||op==5)throw Failure {4};
    }
    if(restoreAttributes & ~0x20a7u)throw Failure {4};
    if(op>5||exists>1||root.size()<3||root[1]!=L':'||root[2]!=L'\\'||relative.find(L':')!=std::wstring::npos||relative.find(L'/')!=std::wstring::npos)throw Failure {
      4
    };
    if(op!=4 && op!=5 && relative.empty())throw Failure {
      4
    };
    std::vector<Held> dirs;
    std::wstring current=root.substr(0,3);
    auto openDir=[&](const std::wstring& p) {
      auto h=hold(dirs.empty()?CreateFileW(p.c_str(),FILE_LIST_DIRECTORY|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr):relativeOpen(dirs.back()->h,p.substr(p.find_last_of(L'\\')+1),FILE_LIST_DIRECTORY|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,true));
      if(!(info(h->h).dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY))throw Failure {
        4
      };
      dirs.push_back(std::move(h));
    };
    openDir(current);
    auto walk=[&](const std::wstring& tail,bool lastFile) {
      size_t start=0;
      while(start<tail.size()) {
        size_t end=tail.find(L'\\',start);
        if(end==std::wstring::npos)end=tail.size();
        auto part=tail.substr(start,end-start);
        if(part.empty()||part.size()>255||part==L"."||part==L".."||part.back()==L'.'||part.back()==L' ')throw Failure {
          4
        };
        for(auto c:part)if(c<32||c==127)throw Failure {4};
        if(current.back()!=L'\\')current+=L'\\';
        current+=part;
        if(!lastFile||end<tail.size())openDir(current);
        start=end+1;
      }
    };
    walk(root.substr(3),false);
    wchar_t fsName[32];
    if(!GetVolumeInformationW(root.substr(0,3).c_str(),nullptr,0,nullptr,nullptr,nullptr,fsName,32)||wcscmp(fsName,L"NTFS")||GetDriveTypeW(root.substr(0,3).c_str())!=DRIVE_FIXED)throw Failure {
      6
    };
    auto rootIdentity=identity(dirs.back()->h);
    if(!expectedRoot.empty() && expectedRoot!=rootIdentity)throw Failure {3};
    if(op==5) {
      if(!relative.empty())throw Failure {4};
      out(0);blob("");blob(rootIdentity);return 0;
    }
    if(!relative.empty())walk(relative,op!=4);
    if(op==4) {
      struct Entry  {
        ULONG next,index;
        LARGE_INTEGER created,accessed,written,changed,size,allocation;
        ULONG attributes,length;
        WCHAR name[1];
      };
      using Query=NTSTATUS (NTAPI*)(HANDLE,HANDLE,PVOID,PVOID,PIO_STATUS_BLOCK,PVOID,ULONG,ULONG,BOOLEAN,PUNICODE_STRING,BOOLEAN);
      auto call=reinterpret_cast<Query>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtQueryDirectoryFile"));
      auto h=dirs.back()->h;
      std::vector<unsigned char>b(64*1024);
      std::string entries;
      bool first=true;
      size_t count=0;
      for(;;) {
        IO_STATUS_BLOCK io {
        };
        NTSTATUS status=call(h,nullptr,nullptr,nullptr,&io,b.data(),static_cast<ULONG>(b.size()),1,FALSE,nullptr,first?TRUE:FALSE);
        first=false;
        if(status==static_cast<NTSTATUS>(0x80000006))break;
        if(status<0)throw Failure {
          4
        };
        auto p=reinterpret_cast<Entry*>(b.data());
        for(;;) {
          std::wstring name(p->name,p->length/2);
          if(name!=L"."&&name!=L"..") {
            for(auto c:name)if(c<32||c==127)throw Failure {4};
            entries+=narrow(name)+"\t"+((p->attributes&FILE_ATTRIBUTE_REPARSE_POINT)?"symlink":(p->attributes&FILE_ATTRIBUTE_DIRECTORY)?"directory":"file")+"\n";
            if(++count==10000)break;
          }if(!p->next)break;
          p=reinterpret_cast<Entry*>(reinterpret_cast<unsigned char*>(p)+p->next);
        }if(count==10000)break;
      }
      std::string ignores;
      for(const auto* name:{L".gitignore",L".ignore",L".rgignore"}) {
        HANDLE raw=relativeOpen(h,name,GENERIC_READ|READ_CONTROL,FILE_SHARE_READ,false);
        if(raw==INVALID_HANDLE_VALUE) {
          if(GetLastError()!=ERROR_FILE_NOT_FOUND)throw Failure {4};
          ignores+=encoded("");continue;
        }
        auto file=hold(raw);auto metadata=info(file->h);
        if(metadata.nFileSizeHigh || metadata.nFileSizeLow>64*1024) {ignores+=encoded("\x01");continue;}
        ignores+=encoded(read(file->h));
      }
      out(0);
      blob(entries);
      blob(ignores);
      return 0;
    }
    point("pinned");
    DWORD access=GENERIC_READ|READ_CONTROL;
    if(op!=0)access|=DELETE|WRITE_DAC;
    HANDLE raw=relativeOpen(dirs.back()->h,current.substr(current.find_last_of(L'\\')+1),access,FILE_SHARE_READ,false);
    bool present=raw!=INVALID_HANDLE_VALUE;
    if(!present&&GetLastError()!=ERROR_FILE_NOT_FOUND)throw Failure {
      GetLastError()==ERROR_SHARING_VIOLATION?3u:4u
    };
    Held target=present?hold(raw):nullptr;
    std::string bytes=present?read(target->h):"";
    if(op==0) {
      out(present?0:1);
      blob(bytes);
      if(present) {
        blob(identity(target->h)+"|"+std::to_string(info(target->h).dwFileAttributes));
      }else blob("");
      return 0;
    }if(present!=(exists!=0)||(present&&bytes!=before))throw Failure {
      2
    };
    if(op!=1&& !present)throw Failure {
      2
    };
    if(!expectedTarget.empty() && (!present || identity(target->h)!=expectedTarget))throw Failure {3};
    bool journalDeletion=op==3 && relative.size()>8 && relative.substr(relative.size()-8)==L".journal" && (before.substr(0,4)=="EPJ2" || before.substr(0,4)=="EPJ3");
    if(after.size()>32*1024*1024 || (!journalDeletion && before.size()>32*1024*1024) || before.size()+after.size()>LIMIT-128*1024)throw Failure {
      6
    };
    point("locked");
    std::wstring backup=current+L".everpeace-recovery-"+(retained.empty()?id():wide(retained))+L".bak";
    std::wstring temp=current+L".everpeace-stage-"+(retained.empty()?id():wide(retained))+L".tmp";
    Held staged;
    PSECURITY_DESCRIPTOR originalSecurity=nullptr;
    PACL originalAcl=nullptr;
    if(op!=3) {
      staged=hold(relativeOpen(dirs.back()->h,temp.substr(temp.find_last_of(L'\\')+1),GENERIC_WRITE|DELETE|READ_CONTROL|WRITE_DAC|FILE_READ_ATTRIBUTES,0,false,true));
      staged->eraseOnClose=true;
      privateAcl(staged->h);
      write(staged->h,after);
      if(present) {
        if(GetSecurityInfo(target->h,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,&originalAcl,nullptr,&originalSecurity)!=ERROR_SUCCESS)throw Failure {
          4
        };
        DWORD e=SetSecurityInfo(staged->h,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,originalAcl,nullptr);
        if(e!=ERROR_SUCCESS)throw Failure {
          4
        };
        FILE_BASIC_INFO basic {
        };
        basic.FileAttributes=info(target->h).dwFileAttributes;
        if(!SetFileInformationByHandle(staged->h,FileBasicInfo,&basic,sizeof basic))throw Failure {
          4
        };
      }
      if(restoreAttributes) {
        FILE_BASIC_INFO basic {}; basic.FileAttributes=restoreAttributes;
        if(!SetFileInformationByHandle(staged->h,FileBasicInfo,&basic,sizeof basic))throw Failure {4};
      }
    }
    if(staged && !FlushFileBuffers(staged->h))throw Failure {4};
    std::wstring journal=backup+L".journal";
    Held journalHandle;
    if(present||!retained.empty()) {
      journalHandle=hold(relativeOpen(dirs.back()->h,journal.substr(journal.find_last_of(L'\\')+1),GENERIC_WRITE|DELETE|WRITE_DAC,0,false,true));
      journalHandle->eraseOnClose=true;
      privateAcl(journalHandle->h);
      auto metadata=std::string(retained.empty()?"EPJ2":"EPJ3")+encoded(narrow(relative))+encoded(before)+encoded(after)+encoded(target?identity(target->h):"")+encoded(staged?identity(staged->h):"");
      if(!retained.empty())metadata+=encoded(rootIdentity)+encoded(std::to_string(exists))+encoded(std::to_string(op!=3))+encoded(staged?narrow(relative)+narrow(temp.substr(current.size())):"");
      write(journalHandle->h,metadata);
      journalHandle->eraseOnClose=false;
      if(!retained.empty())point("journaled");
      if(target)renameHandle(target->h,backup,dirs.back()->h);
      journalHandle->eraseOnClose=false;
      recovery=narrow(backup);
      if(target)privateAcl(target->h);
    }
    point("moved");
    try {
      if(staged) {
        renameHandle(staged->h,current,dirs.back()->h);
        staged->eraseOnClose=false;
        if(!FlushFileBuffers(staged->h))throw Failure {4};
      }
    }catch(Failure f) {
      if(staged) {
        try {
          removeHandle(staged->h);
        }catch(...) {
        }
      }if(target) {
        try {
          renameHandle(target->h,current,dirs.back()->h);
          if(originalAcl)SetSecurityInfo(target->h,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,originalAcl,nullptr);
          recovery.clear();
          if(journalHandle&&retained.empty())removeHandle(journalHandle->h);
        }catch(...) {
        }
      }throw f;
    }
    point("installed");
    if(target&&retained.empty()) {
      removeHandle(target->h);
      recovery.clear();
    }if(journalHandle&&retained.empty())removeHandle(journalHandle->h);
    if(originalSecurity)LocalFree(originalSecurity);
    out(0);
    blob("");
    blob(staged?identity(staged->h)+"|"+std::to_string(info(staged->h).dwFileAttributes):"");
  }catch(Failure f) {
    fprintf(stderr,"native failure %u win32 %lu\n",f.code,GetLastError());
    out(f.code);
    blob("");
    blob(recovery);
  }catch(...) {
    out(4);
    blob("");
    blob(recovery);
  }return 0;
}
