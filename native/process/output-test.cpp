#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <string>
// Test fixture only: keeps running after the output limit unless the owner stops it.
int main() {
  printf("{\"pid\":%lu}\n",GetCurrentProcessId());fflush(stdout);
  const std::string chunk(64*1024,'x');
  for(int i=0;i<40;i++) {fwrite(chunk.data(),1,chunk.size(),stdout);fflush(stdout);}
  for(;;)Sleep(100);
}
