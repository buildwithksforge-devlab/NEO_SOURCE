import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root=process.cwd();

const output=path.join(root,".output/server");

const configPath=path.join(output,"wrangler.json");

const marker="NEO_GENERATED_PAYMENT_WORKER_V1";

const queueName="neo-preview-payment-callbacks";

const deadLetterName="neo-preview-payment-callbacks-dlq";

function files(directory){

  const result=[];

  for(const item of fs.readdirSync(
    directory,
    {withFileTypes:true},
  )){

    const location=path.join(directory,item.name);

    if(item.isDirectory()){

      result.push(...files(location));

    }else if(
      item.isFile() &&
      location.endsWith(".mjs")
    ){

      result.push(location);

    }

  }

  return result;

}

function queueConfiguration(config){

  // Preserve any unrelated queue configuration.

  const existing=config.queues ?? {};

  const producers=existing.producers ?? [];

  const consumers=existing.consumers ?? [];

  assert.ok(Array.isArray(producers));

  assert.ok(Array.isArray(consumers));

  const conflictingProducer=producers.find(
    item =>
      item.binding==="NEO_PAYMENT_QUEUE" &&
      item.queue!==queueName
  );

  assert.ok(
    !conflictingProducer,
    "Existing payment queue binding conflicts"
  );

  const otherProducers=producers.filter(
    item => item.binding!=="NEO_PAYMENT_QUEUE"
  );

  const otherConsumers=consumers.filter(
    item => item.queue!==queueName
  );

  assert.ok(
    !otherConsumers.some(
      item => item.queue===deadLetterName
    ),
    "Dead-letter queue must not have an automatic consumer"
  );

  config.queues={

    ...existing,

    producers:[

      ...otherProducers,

      {

        binding:"NEO_PAYMENT_QUEUE",

        queue:queueName,

      },

    ],

    consumers:[

      ...otherConsumers,

      {

        queue:queueName,

        max_batch_size:20,

        max_batch_timeout:5,

        max_retries:20,

        max_concurrency:5,

        dead_letter_queue:deadLetterName,

      },

    ],

  };

  // Preparation must not enable payment traffic.
  // No keys, callback tokens or credentials are written.

  config.vars={

    ...(config.vars ?? {}),

    NEO_PAYMENT_QUEUE_ENABLED:"false",

    NEO_PAYMENT_QUEUE_DRAIN_ENABLED:"false",

  };

  config.keep_vars=true;

  return config;

}

async function main(){

  assert.ok(
    fs.existsSync(configPath),
    "Generated Worker configuration missing"
  );

  const config=JSON.parse(
    fs.readFileSync(configPath,"utf8")
  );

  assert.equal(config.name,"neo-preview");

  const entry=path.resolve(output,config.main);

  assert.ok(
    entry.startsWith(output+path.sep),
    "Generated entry outside release output"
  );

  const source=fs.readFileSync(entry,"utf8");

  assert.ok(
    !source.includes(marker),
    "Payment Worker already connected"
  );

  // Find an actually exported application dispatcher.
  // Merely locating its name inside a compiled bundle
  // is insufficient.

  const candidates=[];

  for(const location of files(output)){

    if(location===entry) continue;

    const compiled=fs.readFileSync(location,"utf8");

    if(
      !compiled.includes("neoPaymentWorkerEvents")
    ) continue;

    const exports=[

      ...compiled.matchAll(
        /export\s*\{([^}]+)\}/g
      ),

    ];

    for(const match of exports){

      const entries=match[1]
        .split(",")
        .map(item=>item.trim());

      const exported=entries.some(

        item =>
          item==="neoPaymentWorkerEvents" ||
          /\bas\s+neoPaymentWorkerEvents$/.test(item)

      );

      if(exported){

        candidates.push(location);

        break;

      }

    }

    if(
      /\bexport\s+const\s+neoPaymentWorkerEvents\b/
        .test(compiled)
    ){

      candidates.push(location);

    }

  }

  const unique=[...new Set(candidates)];

  assert.equal(

    unique.length,

    1,

    "Expected one exported payment dispatcher; found "+
      unique.length

  );

  let relative=path.relative(
    path.dirname(entry),
    unique[0]
  ).replaceAll("\\","/");

  if(!relative.startsWith(".")){

    relative="./"+relative;

  }

  const queuePattern=

    /queue\s*\(\s*batch\s*,\s*env\s*,\s*context\s*\)\s*\{/g;

  const scheduledPattern=

    /scheduled\s*\(\s*controller\s*,\s*env\s*,\s*context\s*\)\s*\{/g;

  const queueMatches=[

    ...source.matchAll(queuePattern),

  ];

  const scheduleMatches=[

    ...source.matchAll(scheduledPattern),

  ];

  assert.equal(

    queueMatches.length,

    1,

    "Generated Nitro queue handler not uniquely identified"

  );

  assert.equal(

    scheduleMatches.length,

    1,

    "Generated Nitro scheduled handler not uniquely identified"

  );

  let patched=source.replace(

    queuePattern,

    match=>match+`

      // ${marker}

      if (
        batch.queue === "${queueName}" ||
        batch.queue === "${deadLetterName}"
      ) {

        globalThis.__env__ = env;

        return neoPaymentWorkerEvents.queue(
          batch,
          env
        );

      }

`

  );

  patched=patched.replace(

    scheduledPattern,

    match=>match+`

      if (
        env.NEO_PAYMENT_SCHEDULER_ENABLED === "true"
      ) {

        globalThis.__env__ = env;

        context.waitUntil(

          neoPaymentWorkerEvents.scheduled(env)

        );

      }

`

  );

  patched=

    `import { neoPaymentWorkerEvents } from ${JSON.stringify(relative)};\n`+

    patched;


  // NEO_GENERATED_PAYMENT_HTTP_V2

  // Wrap the final exported Worker object instead of
  // relying on TanStack forwarding the Cloudflare bindings.

  const defaultExportPattern =
    /export\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+default\s*\}\s*;?/g;

  const defaultExports=[
    ...patched.matchAll(defaultExportPattern)
  ];

  assert.equal(
    defaultExports.length,
    1,
    "Generated Worker default export not uniquely identified"
  );

  const originalWorker=defaultExports[0][1];

  const replacement=`

// NEO_GENERATED_PAYMENT_HTTP_V2

const neoPaymentWrappedWorker = {

  ...${originalWorker},

  async fetch(request, env, context) {

    const response = await neoPaymentWorkerEvents.fetch(
      request,
      env ?? {}
    );

    if (response !== null) {

      return response;

    }

    return ${originalWorker}.fetch.call(
      ${originalWorker},
      request,
      env,
      context
    );

  }

};

export { neoPaymentWrappedWorker as default };

`;

  patched=patched.replace(
    defaultExportPattern,
    ()=>replacement
  );

  console.log(
    "CONNECTED_GENERATED_PAYMENT_HTTP",
    JSON.stringify({
      independentIngress:true,
      originalHttpFallback:true,
      queueHandlersPreserved:true,
      scheduledHandlersPreserved:true
    })
  );

// Validate configuration before changing the bundle.

  const preparedConfig=queueConfiguration(config);

  fs.writeFileSync(

    entry,

    patched,

    "utf8"

  );

  fs.writeFileSync(

    configPath,

    JSON.stringify(preparedConfig,null,2)+"\n",

    "utf8"

  );

  console.log(

    "CONNECTED_PAYMENT_WORKER",

    JSON.stringify({

      queue:queueName,

      deadLetter:deadLetterName,

      batchSize:20,

      batchConcurrency:5,

      applicationConcurrency:4,

      maximumRetries:20,

      intakeEnabled:false,

      drainEnabled:false,

      existingHttpHandlerPreserved:true,

    })

  );

}

main().catch(error=>{

  console.error(error);

  process.exitCode=1;

});