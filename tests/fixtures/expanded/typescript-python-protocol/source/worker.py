import json,sys,time
request=json.loads(sys.stdin.readline())
time.sleep(request.get('delay',0))
print(json.dumps({'requestId':request['requestId'],'total':sum(request['values'])}),flush=True)
