import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

const db = supabase as any;

type Item = {
  id:string;
  menu_item_id:string;
  item_name:string;
  quantity:number;
  unit_price:number;
  normal_value:number;
};

type Context = {
  order_id:string;
  order_number:string;
  branch_id:string;
  customer_id:string|null;
  currency:string;
  items:Item[];
};

export type ComplimentaryOrderSelection = {
  orderId:string;
  branchId:string;
  customerId:string|null;
  menuItemId:string;
  orderItemId:string;
  itemName:string;
  quantity:number;
  unitPrice:number;
};

export function ComplimentaryRequestSelection({
  onSelect,
  onClear,
}:{
  onSelect:(value:ComplimentaryOrderSelection)=>void;
  onClear:()=>void;
}) {

  const {organizationId,user}=useAuth();

  const [expanded,setExpanded]=useState(false);
  const [orderId,setOrderId]=useState("");
  const [selected,setSelected]=useState("");

  const orders=useQuery({

    queryKey:[
      "complimentary-request-orders",
      organizationId,
      user?.id,
    ],

    enabled:expanded &&
      Boolean(organizationId && user?.id),

    staleTime:0,
    gcTime:0,

    queryFn:async()=>{

      const {data,error}=await db
        .from("pos_orders")
        .select("id,order_number,branch_id,status,currency")
        .eq("organization_id",organizationId)
        .eq("payment_status","unpaid")
        .eq("paid_total",0)
        .in("status",[
          "draft",
          "sent",
          "accepted",
          "in-preparation",
          "partially-ready",
          "ready",
          "partially-served",
          "served",
          "awaiting-payment",
        ])
        .order("created_at",{ascending:false})
        .limit(100);

      if(error) throw new Error(error.message);

      return (data??[]) as Array<{
        id:string;
        order_number:string;
        status:string;
      }>;
    },
  });

  const context=useQuery({

    queryKey:[
      "complimentary-request-context",
      organizationId,
      user?.id,
      orderId,
    ],

    enabled:expanded &&
      Boolean(orderId && organizationId && user?.id),

    staleTime:0,
    gcTime:0,

    queryFn:async():Promise<Context>=>{

      const {data,error}=await db.rpc(
        "neo_pos_complimentary_request_context",
        {_order:orderId}
      );

      if(error) throw new Error(error.message);

      if(
        data?.order_id!==orderId ||
        !Array.isArray(data.items) ||
        !data.branch_id
      ) {
        throw new Error(
          "Original complimentary order could not be verified."
        );
      }

      return data as Context;
    },
  });

  function clear() {

    setSelected("");

    onClear();
  }

  function selectItem(id:string) {

    clear();

    if (
      !id ||
      !context.isSuccess ||
      context.isFetching ||
      context.data.order_id!==orderId
    ) return;

    const item=context.data.items.find(
      row=>row.id===id
    );

    if(
      !item ||
      !Number.isFinite(Number(item.quantity)) ||
      !Number.isFinite(Number(item.unit_price)) ||
      Number(item.quantity)<=0 ||
      Number(item.unit_price)<0
    ) return;

    setSelected(id);

    onSelect({

      orderId,

      branchId:context.data.branch_id,

      customerId:context.data.customer_id,

      menuItemId:item.menu_item_id,

      orderItemId:item.id,

      itemName:item.item_name,

      quantity:Number(item.quantity),

      unitPrice:Number(item.unit_price),
    });
  }

  return (

    <section className="space-y-3 rounded border border-border p-3">

      <button
        type="button"
        className="text-sm font-semibold"
        onClick={()=>{

          if(expanded) {

            clear();
            setOrderId("");
          }

          setExpanded(value=>!value);
        }}
      >
        {expanded
          ? "Remove POS order association"
          : "Associate with an existing POS order"}
      </button>

      {expanded && (

        <>

          <label className="block text-xs">

            Original unpaid POS order

            <select
              value={orderId}
              disabled={orders.isFetching}
              onChange={e=>{

                clear();

                setOrderId(e.target.value);
              }}
              className="mt-1 w-full rounded border border-input bg-background p-2 text-sm"
            >

              <option value="">
                Select original order
              </option>

              {orders.data?.map(order=>(
                <option
                  key={order.id}
                  value={order.id}
                >
                  {order.order_number} — {order.status}
                </option>
              ))}

            </select>

          </label>

          {orders.isError && (

            <p role="alert" className="text-xs text-destructive">
              POS orders are unavailable for this session.
            </p>

          )}

          {orderId && (

            <label className="block text-xs">

              Original draft menu item

              <select
                value={selected}
                disabled={
                  !context.isSuccess ||
                  context.isFetching
                }
                onChange={e=>selectItem(e.target.value)}
                className="mt-1 w-full rounded border border-input bg-background p-2 text-sm"
              >

                <option value="">
                  Select original draft item
                </option>

                {context.data?.items.map(item=>(
                  <option
                    key={item.id}
                    value={item.id}
                  >
                    {item.quantity} × {item.item_name}
                    {" — "}
                    {context.data.currency}
                    {" "}
                    {Number(item.normal_value).toFixed(2)}
                  </option>
                ))}

              </select>

            </label>

          )}

          {context.isError && (

            <p role="alert" className="text-xs text-destructive">
              This order is unavailable for complimentary requests.
            </p>

          )}

          {context.isSuccess &&
           context.data.items.length===0 && (

            <p className="text-xs text-muted-foreground">
              No eligible unpaid draft items are available.
            </p>

          )}

          <p className="text-xs text-muted-foreground">
            Order identity, menu item, quantity and normal
            selling price are obtained from the original POS order.
          </p>

        </>

      )}

    </section>
  );
}