export function calculateInvoice(items){return {total:items.reduce((sum,item)=>sum+item.price*item.quantity,0),currency:'USD'};}
