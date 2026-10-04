/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/predge_guard.json`.
 */
export type PredgeGuard = {
  "address": "B2gNjSeDBWHoLG3qdnsKVv5mqYMAZ3cULyCY4AZ3Jush",
  "metadata": {
    "name": "predgeGuard",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Predge Settlement Guard: signed settlement-risk attestations and a settlement gate for Solana markets"
  },
  "instructions": [
    {
      "name": "checkSettlement",
      "docs": [
        "Settlement gate. Succeeds only if the reference market is settled and",
        "the cooling window has passed. Meant to be called via CPI by any",
        "program that settles on the reference outcome."
      ],
      "discriminator": [
        9,
        104,
        65,
        157,
        132,
        211,
        255,
        7
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "marketRisk",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  105,
                  115,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market_risk.market_key",
                "account": "marketRisk"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "initialize",
      "docs": [
        "Create the singleton config: who may sign attestations and how long a",
        "settled market must age before consumers treat it as final."
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
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
          "name": "attestor",
          "type": "pubkey"
        },
        {
          "name": "coolingSecs",
          "type": "i64"
        }
      ]
    },
    {
      "name": "openEscrow",
      "docs": [
        "Demo consumer: lock lamports for a beneficiary until the reference",
        "market behind `market_key` is final."
      ],
      "discriminator": [
        82,
        178,
        155,
        253,
        74,
        41,
        161,
        219
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
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "depositor"
              },
              {
                "kind": "arg",
                "path": "escrowId"
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
          "name": "escrowId",
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
      "name": "postAttestation",
      "docs": [
        "Record a signed attestation. Permissionless: validity comes from the",
        "ed25519 signature, checked through the instructions sysvar."
      ],
      "discriminator": [
        12,
        75,
        255,
        83,
        59,
        171,
        141,
        27
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "marketRisk",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  105,
                  115,
                  107
                ]
              },
              {
                "kind": "arg",
                "path": "att.market_key"
              }
            ]
          }
        },
        {
          "name": "instructionsSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "att",
          "type": {
            "defined": {
              "name": "attestation"
            }
          }
        }
      ]
    },
    {
      "name": "releaseEscrow",
      "docs": [
        "Release the escrow to the beneficiary. Fails with a specific error",
        "while the reference market is still at risk."
      ],
      "discriminator": [
        146,
        253,
        129,
        233,
        20,
        145,
        181,
        206
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
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "marketRisk",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  105,
                  115,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "escrow.market_key",
                "account": "escrow"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "escrow.depositor",
                "account": "escrow"
              },
              {
                "kind": "account",
                "path": "escrow.escrow_id",
                "account": "escrow"
              }
            ]
          }
        },
        {
          "name": "beneficiary",
          "writable": true,
          "relations": [
            "escrow"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "updateConfig",
      "docs": [
        "Rotate the attestor key or change the cooling window. Admin only."
      ],
      "discriminator": [
        29,
        158,
        252,
        191,
        10,
        83,
        219,
        99
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "attestor",
          "type": "pubkey"
        },
        {
          "name": "coolingSecs",
          "type": "i64"
        }
      ]
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
      "name": "escrow",
      "discriminator": [
        31,
        213,
        123,
        187,
        186,
        22,
        218,
        155
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
    }
  ],
  "events": [
    {
      "name": "attestationPosted",
      "discriminator": [
        142,
        97,
        81,
        56,
        69,
        155,
        19,
        243
      ]
    },
    {
      "name": "escrowReleased",
      "discriminator": [
        131,
        7,
        138,
        104,
        166,
        190,
        113,
        112
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidConfig",
      "msg": "Invalid config"
    },
    {
      "code": 6001,
      "name": "invalidStatus",
      "msg": "Invalid status"
    },
    {
      "code": 6002,
      "name": "invalidRisk",
      "msg": "risk_bps must be at most 10000"
    },
    {
      "code": 6003,
      "name": "futureAttestation",
      "msg": "Attestation is dated in the future"
    },
    {
      "code": 6004,
      "name": "staleAttestation",
      "msg": "Attestation is not newer than the stored one"
    },
    {
      "code": 6005,
      "name": "alreadySettled",
      "msg": "Market already settled; only a settled restatement is accepted"
    },
    {
      "code": 6006,
      "name": "missingEd25519Ix",
      "msg": "Expected an Ed25519 signature instruction right before this one"
    },
    {
      "code": 6007,
      "name": "badEd25519Ix",
      "msg": "Malformed Ed25519 instruction"
    },
    {
      "code": 6008,
      "name": "wrongAttestor",
      "msg": "Signature is not from the configured attestor"
    },
    {
      "code": 6009,
      "name": "messageMismatch",
      "msg": "Signed message does not match the attestation"
    },
    {
      "code": 6010,
      "name": "settlementNotFinal",
      "msg": "Reference market is not settled yet"
    },
    {
      "code": 6011,
      "name": "marketDisputed",
      "msg": "Reference market is disputed"
    },
    {
      "code": 6012,
      "name": "marketEscalated",
      "msg": "Reference market is escalated to a UMA vote"
    },
    {
      "code": 6013,
      "name": "coolingPeriod",
      "msg": "Reference market settled but the cooling window has not passed"
    },
    {
      "code": 6014,
      "name": "invalidAmount",
      "msg": "Amount must be positive"
    }
  ],
  "types": [
    {
      "name": "attestation",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketKey",
            "docs": [
              "sha256(\"polymarket:\" + UMA questionID hex, lowercase, 0x-prefixed)."
            ],
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
            "docs": [
              "1 if the settled outcome differs from the last disputed proposal."
            ],
            "type": "u8"
          },
          {
            "name": "riskBps",
            "docs": [
              "Attestor's estimate, in basis points, that the currently proposed",
              "outcome does not stand. 0 once settled."
            ],
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
            "docs": [
              "sha256 of the canonical bytes of the off-chain signed evidence pack."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "attestationPosted",
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
            "name": "riskBps",
            "type": "u16"
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
          }
        ]
      }
    },
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
      "name": "escrow",
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
            "name": "escrowId",
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
      "name": "escrowReleased",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "escrow",
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
    }
  ]
};
