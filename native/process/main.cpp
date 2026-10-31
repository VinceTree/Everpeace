#define _WIN32_WINNT 0x0A00
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <string>
#include <vector>
#include <stdexcept>

// EPP2: private owner-only control pipe; stdout/stderr belong exclusively to payload.
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE h): value(h) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
static void check(bool ok) { if (!ok) throw GetLastError(); }
static void exact(HANDLE h, void* value, DWORD count) {
  char* p = static_cast<char*>(value);
  while (count) { DWORD read = 0; check(ReadFile(h,p,count,&read,nullptr) && read); p += read; count -= read; }
}
static DWORD number(HANDLE h) { DWORD n; exact(h,&n,4); return n; }
static std::wstring field(HANDLE h, size_t& total) {
  DWORD n = number(h); total += n; if (total > 1024*1024 || n > 256*1024) throw DWORD(ERROR_INVALID_DATA);
  std::string s(n,'\0'); if(n)exact(h,s.data(),n);
  if(s.find('\0')!=std::string::npos)throw DWORD(ERROR_INVALID_DATA);
  int length = MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),n,nullptr,0);
  if(n && !length)throw DWORD(ERROR_INVALID_DATA);
  std::wstring result(length,L'\0'); if(length)MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),n,result.data(),length);
  return result;
}
static void send(HANDLE pipe,const std::string& message) {
  DWORD n; check(WriteFile(pipe,message.data(),static_cast<DWORD>(message.size()),&n,nullptr) && n==message.size());
}
static std::wstring quote(const std::wstring& text) {
  std::wstring result=L"\""; size_t slashes=0;
  for(wchar_t c:text) { if(c==L'\\'){slashes++;continue;} result.append(c==L'"'?slashes*2+1:slashes,L'\\');slashes=0;result+=c; }
  result.append(slashes*2,L'\\');return result+L"\"";
}
int wmain(int argc,wchar_t** argv) {
  if(argc!=3 || std::wstring(argv[1])!=L"--pipe" || std::wstring(argv[2]).find(L"\\\\.\\pipe\\everpeace-owner-")!=0)return 120;
  HANDLE pipe=INVALID_HANDLE_VALUE;
  Handle pipeControl(INVALID_HANDLE_VALUE);
  bool started=false;
  try {
    Handle token(nullptr); check(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token.value));
    DWORD size=0;GetTokenInformation(token.value,TokenUser,nullptr,0,&size);std::vector<char> user(size);
    check(GetTokenInformation(token.value,TokenUser,user.data(),size,&size));
    LPWSTR sid=nullptr;check(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid,&sid));
    std::wstring sddl=L"D:P(A;;GA;;;"+std::wstring(sid)+L")";LocalFree(sid);
    PSECURITY_DESCRIPTOR descriptor=nullptr;check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),SDDL_REVISION_1,&descriptor,nullptr));
    SECURITY_ATTRIBUTES security{sizeof security,descriptor,FALSE};
    pipe=CreateNamedPipeW(argv[2],PIPE_ACCESS_DUPLEX|FILE_FLAG_FIRST_PIPE_INSTANCE,PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,1,4096,4096,0,&security);
    LocalFree(descriptor);check(pipe!=INVALID_HANDLE_VALUE);pipeControl.value=pipe;
    check(ConnectNamedPipe(pipe,nullptr)||GetLastError()==ERROR_PIPE_CONNECTED);
    char magic[4];exact(pipe,magic,4);if(std::string(magic,4)!="EPP2")throw DWORD(ERROR_INVALID_DATA);
    size_t total=0;auto executable=field(pipe,total);auto cwd=field(pipe,total);
    DWORD count=number(pipe);if(count>4096)throw DWORD(ERROR_INVALID_DATA);
    std::wstring command=quote(executable);
    for(DWORD i=0;i<count;i++)command+=L" "+quote(field(pipe,total));
    count=number(pipe);if(count>4096)throw DWORD(ERROR_INVALID_DATA);
    std::wstring environment;
    for(DWORD i=0;i<count;i++) {auto value=field(pipe,total);if(value.find(L'=')==std::wstring::npos)throw DWORD(ERROR_INVALID_DATA);environment+=value;environment.push_back(0);}
    environment.push_back(0);if(count==0)environment.push_back(0);
    if(executable.size()<3 || !(executable[1]==L':'&&executable[2]==L'\\') && executable.substr(0,2)!=L"\\\\")throw DWORD(ERROR_INVALID_DATA);
    Handle job(CreateJobObjectW(nullptr,nullptr));check(job.value!=nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    check(SetInformationJobObject(job.value,JobObjectExtendedLimitInformation,&limits,sizeof limits));
    STARTUPINFOEXW start{};start.StartupInfo.cb=sizeof start;start.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
    HANDLE inherited[3];
    for(int i=0;i<3;i++)check(DuplicateHandle(GetCurrentProcess(),GetStdHandle(i==0?STD_INPUT_HANDLE:i==1?STD_OUTPUT_HANDLE:STD_ERROR_HANDLE),GetCurrentProcess(),&inherited[i],0,TRUE,DUPLICATE_SAME_ACCESS));
    Handle in(inherited[0]),out(inherited[1]),err(inherited[2]);start.StartupInfo.hStdInput=in.value;start.StartupInfo.hStdOutput=out.value;start.StartupInfo.hStdError=err.value;
    SIZE_T bytes=0;InitializeProcThreadAttributeList(nullptr,2,0,&bytes);std::vector<char> attributes(bytes);
    start.lpAttributeList=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());check(InitializeProcThreadAttributeList(start.lpAttributeList,2,0,&bytes));
    check(UpdateProcThreadAttribute(start.lpAttributeList,0,PROC_THREAD_ATTRIBUTE_JOB_LIST,&job.value,sizeof(HANDLE),nullptr,nullptr));
    check(UpdateProcThreadAttribute(start.lpAttributeList,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof inherited,nullptr,nullptr));
    PROCESS_INFORMATION created{};
    BOOL ok=CreateProcessW(executable.c_str(),command.data(),nullptr,nullptr,TRUE,EXTENDED_STARTUPINFO_PRESENT|CREATE_UNICODE_ENVIRONMENT|CREATE_SUSPENDED,environment.data(),cwd.empty()?nullptr:cwd.c_str(),&start.StartupInfo,&created);
    DWORD launchError=GetLastError();DeleteProcThreadAttributeList(start.lpAttributeList);if(!ok)throw launchError;
    started=true;
    Handle process(created.hProcess),thread(created.hThread);
    FILETIME born,exit,kernel,time;check(GetProcessTimes(process.value,&born,&exit,&kernel,&time));
    send(pipe,"{\"event\":\"ready\",\"pid\":"+std::to_string(created.dwProcessId)+",\"identity\":\""+std::to_string(born.dwHighDateTime)+":"+std::to_string(born.dwLowDateTime)+"\"}\n");
    check(ResumeThread(thread.value)!=DWORD(-1));
    bool stopping=false,requested=false,expired=false;ULONGLONG deadline=0;DWORD code=0;std::string controlLine;
    for(;;) {
      bool queried=false;
      DWORD available=0;
      if(!PeekNamedPipe(pipe,nullptr,0,nullptr,&available,nullptr))stopping=true;
      while(available-- && !stopping) {
        char c;DWORD n;if(!ReadFile(pipe,&c,1,&n,nullptr)||!n){stopping=true;break;}
        if(c=='\n') {if(controlLine=="stop")stopping=true;else if(controlLine=="status")queried=true;else throw DWORD(ERROR_INVALID_DATA);controlLine.clear();}
        else {controlLine+=c;if(controlLine.size()>16)throw DWORD(ERROR_INVALID_DATA);}
      }
      DWORD waited=WaitForSingleObject(process.value,0);if(waited==WAIT_FAILED)throw GetLastError();
      bool rootExited=waited==WAIT_OBJECT_0;
      if((rootExited||stopping)&&!requested) {requested=true;deadline=GetTickCount64()+5000;check(TerminateJobObject(job.value,1));}
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      check(QueryInformationJobObject(job.value,JobObjectBasicAccountingInformation,&accounting,sizeof accounting,nullptr));
      if(queried)send(pipe,"{\"event\":\"status\",\"status\":\""+std::string(rootExited&&accounting.ActiveProcesses==0?"confirmed_exited":"still_running")+"\",\"exitCode\":null}\n");
      if(rootExited&&accounting.ActiveProcesses==0) {check(GetExitCodeProcess(process.value,&code));break;}
      if(requested&&GetTickCount64()>=deadline) {expired=true;break;}
      Sleep(10);
    }
    send(pipe,"{\"event\":\"exit\",\"status\":\""+std::string(expired?"unknown":"confirmed_exited")+"\",\"exitCode\":"+std::to_string(code)+"}\n");
    return expired?121:0;
  } catch(DWORD error) {
    if(pipe!=INVALID_HANDLE_VALUE) {try{send(pipe,"{\"event\":\""+std::string(started?"error":"launch_error")+"\",\"winError\":"+std::to_string(error)+"}\n");}catch(...){} }
    return 122;
  } catch(...) {return 123;}
}
