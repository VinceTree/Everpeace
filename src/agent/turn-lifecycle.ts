/** Owns turn cancellation, disposal and in-flight operation identity. */
export class TurnLifecycle<T> {
  #controller: AbortController|undefined;
  #operation: Promise<T>|undefined;
  #running=false;
  #disposed=false;
  #disposal: Promise<void>|undefined;
  get controller(){return this.#controller;}
  get operation(){return this.#operation;}
  get running(){return this.#running;}
  get disposed(){return this.#disposed;}
  setController(controller:AbortController):void{this.#controller=controller;}
  setOperation(operation:Promise<T>):void{this.#operation=operation;}
  markRunning():void{this.#running=true;}
  markIdle():void{this.#running=false;}
  clearTurn():void{this.#controller=undefined;this.#operation=undefined;this.#running=false;}
  markDisposed():void{this.#disposed=true;}
  disposeOnce(run:()=>Promise<void>):Promise<void>{return this.#disposal??=run();}
}
