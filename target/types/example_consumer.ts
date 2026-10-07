/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/example_consumer.json`.
 */
export type ExampleConsumer = {
  "address": "6HSBJp8n4wM3RdjbbJY5XoKkBAH16HL8hEPbgk1RwUpg",
  "metadata": {
    "name": "exampleConsumer",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Example consumer: a settlement vault that calls predge_guard::check_settlement via CPI before releasing funds"
  },
  "instructions": [
    {
      "name": "deposit",
      "docs": [
        "Lock `amount` lamports for `beneficiary` until the market behind",
        "`market_key` is final according to Predge Settlement Guard."
      ],
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "depositor",
          "writable": true,
          "signer": true
        },
        {
          "name": "beneficiary"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "depositor"
              },
              {
                "kind": "arg",
                "path": "vaultId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "vaultId",
          "type": "u64"
        },
        {
          "name": "marketKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "release",
      "docs": [
        "Release the vault to the beneficiary, but only after the guard says the",
        "reference market is final."
      ],
      "discriminator": [
        253,
        249,
        15,
        206,
        28,
        127,
        193,
        241
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Anyone may trigger release; funds can only go to the beneficiary."
          ],
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.depositor",
                "account": "vault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "beneficiary",
          "writable": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "guardConfig",
          "docs": [
            "Predge Settlement Guard config PDA (owner-checked as a guard account;",
            "its seeds are re-checked inside `check_settlement`)."
          ]
        },
        {
          "name": "marketRisk",
          "docs": [
            "The reference market's risk record. It must be the one this vault",
            "was opened against; the guard re-checks its PDA seeds."
          ]
        },
        {
          "name": "predgeGuard",
          "address": "B2gNjSeDBWHoLG3qdnsKVv5mqYMAZ3cULyCY4AZ3Jush"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "marketRisk",
      "discriminator": [
        239,
        210,
        123,
        246,
        232,
        219,
        139,
        238
      ]
    },
    {
      "name": "vault",
      "discriminator": [
        211,
        8,
        232,
        43,
        2,
        152,
        117,
        119
      ]
    }
  ],
  "events": [
    {
      "name": "vaultReleased",
      "discriminator": [
        71,
        205,
        57,
        90,
        244,
        213,
        241,
        226
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidAmount",
      "msg": "Amount must be positive"
    },
    {
      "code": 6001,
      "name": "wrongMarket",
      "msg": "MarketRisk account is not for this vault's market"
    }
  ],
  "types": [
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "attestor",
            "type": "pubkey"
          },
          {
            "name": "coolingSecs",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "marketRisk",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketKey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "disputeCount",
            "type": "u8"
          },
          {
            "name": "settledDifferently",
            "type": "u8"
          },
          {
            "name": "riskBps",
            "type": "u16"
          },
          {
            "name": "settledAt",
            "type": "i64"
          },
          {
            "name": "observedAt",
            "type": "i64"
          },
          {
            "name": "evidenceHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "updatedSlot",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "vault",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "depositor",
            "type": "pubkey"
          },
          {
            "name": "beneficiary",
            "type": "pubkey"
          },
          {
            "name": "marketKey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "vaultId",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "vaultReleased",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "marketKey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
