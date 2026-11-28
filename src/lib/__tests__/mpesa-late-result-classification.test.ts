import {describe,it,expect} from "vitest";

import {

  mpesaResultApplied,

  mpesaLateResult,

  mpesaCallbackAcknowledgable,

} from "../mpesa-application-result";

const exceptionId="00000000-0000-4000-8000-000000000101";

const journalId="00000000-0000-4000-8000-000000000102";

const accounted={

  handled:true,

  applied:false,

  status:"overpayment-accounted",

  exception_id:exceptionId,

  journal_id:journalId,

  financially_posted:true,

  retry_required:false,

};

const pending={

  handled:true,

  applied:false,

  status:"awaiting-accounting",

  exception_id:exceptionId,

  financially_posted:false,

  retry_required:true,

};

describe("M-Pesa late payment result classification",()=>{

  it("acknowledges ordinary successful application",()=>{

    expect(

      mpesaCallbackAcknowledgable({

        applied:true,

        status:"success",

      },0)

    ).toBe(true);

  });

  it("acknowledges an ordinary duplicate application",()=>{

    expect(

      mpesaCallbackAcknowledgable({

        duplicate:true,

        status:"success",

      },0)

    ).toBe(true);

  });

  it("acknowledges an accounted additional receipt",()=>{

    expect(

      mpesaCallbackAcknowledgable(accounted,0)

    ).toBe(true);

  });

  it("does not classify additional funds as bill settlement",()=>{

    expect(

      mpesaResultApplied(accounted,0)

    ).toBe(false);

  });

  it("returns the saved financial journal identity",()=>{

    const result=mpesaLateResult(accounted,0);

    expect(result?.state).toBe("overpayment-accounted");

    expect(result?.journalId).toBe(journalId);

    expect(result?.exceptionId).toBe(exceptionId);

    expect(result?.financiallyPosted).toBe(true);

  });

  it("does not acknowledge unposted additional money",()=>{

    expect(

      mpesaCallbackAcknowledgable(pending,0)

    ).toBe(false);

  });

  it("preserves the pending reconciliation outcome",()=>{

    const result=mpesaLateResult(pending,0);

    expect(result?.state).toBe("awaiting-accounting");

    expect(result?.retryRequired).toBe(true);

    expect(result?.journalId).toBeNull();

  });

  it("does not falsely settle a bill awaiting reconciliation",()=>{

    expect(

      mpesaResultApplied(pending,0)

    ).toBe(false);

  });

  it.each([

    {journal_id:null},

    {journal_id:"invalid"},

    {journal_id:"00000000-0000-0000-0000-000000000000"},

    {exception_id:null},

    {exception_id:"invalid"},

    {financially_posted:false},

    {retry_required:true},

    {handled:false},

    {applied:true},

    {ok:false},

    {duplicate:true},

  ])("rejects inconsistent accounting evidence %j",change=>{

    const result={...accounted,...change};

    expect(mpesaLateResult(result,0)).toBeNull();

    expect(

      mpesaCallbackAcknowledgable(result,0)

    ).toBe(false);

  });

  it("rejects additional receipt classification for a failed result",()=>{

    expect(

      mpesaCallbackAcknowledgable(accounted,1032)

    ).toBe(false);

    expect(

      mpesaLateResult(accounted,1032)

    ).toBeNull();

  });

  it("preserves normal cancelled-payment acknowledgement",()=>{

    expect(

      mpesaCallbackAcknowledgable({

        applied:true,

        status:"cancelled",

      },1032)

    ).toBe(true);

  });

  it("preserves normal timeout acknowledgement",()=>{

    expect(

      mpesaCallbackAcknowledgable({

        applied:true,

        status:"timeout",

      },1037)

    ).toBe(true);

  });

  it("rejects a pending result with a conflicting journal identity",()=>{

    expect(

      mpesaLateResult({

        ...pending,

        journal_id:journalId,

      },0)

    ).toBeNull();

  });

  it("rejects transport success without financial evidence",()=>{

    expect(

      mpesaCallbackAcknowledgable({

        ok:true,

      },0)

    ).toBe(false);

  });

  it.each([null,undefined,[],true,"success",42])(

    "rejects malformed result %j",

    value=>{

      expect(

        mpesaCallbackAcknowledgable(value,0)

      ).toBe(false);

    }

  );

});