# folks-finance-xchain-contracts

The smart contracts for the Folks Finance Cross-Chain Lending Protocol.

## Getting Started

The repository uses both Hardhat and Foundry.

To setup:

1. Clone the repo
2. Run `npm install`
3. Run `forge install`

To build:

1. (Optional) run `npm run clean`
2. Run `npm run build`

## Smart Contracts

The smart contracts are split into 6 distinct folders:

- `contracts/bridge` contains all the smart contracts relating to sending messages (data and token) between the spoke chains and hub chain. Unless named specifically, they are deployed both in the spoke chains and hub chain.
- `contracts/hub` contains the smart contracts relating to the core business logic of the protocol. They are deployed only in the hub chain.
- `contracts/hub-rewards` contains the smart contracts relating to the core business logic of the on-chain rewards. They are deployed only in the hub chain.
- `contracts/oracle` contains the smart contracts relating to the oracle for token price information. They are deployed only in the hub chain.
- `contracts/spoke` contains the smart contracts relating to the user entry point into the protocol. They are deployed only in the spoke chains (the hub chain may also be a spoke chain).
- `contracts/spoke-rewards` contains the smart contracts relating to the user entry point into the on-chain rewards. They are deployed only in the spoke chains (the hub chain may also be a spoke chain).

Within each you can also find `test` folder which contains smart contracts used for testing. These are not part of the protocol and won't be deployed.

## Testing

To run all tests `npm run test`.

To run specific tests `npm run test ${PATH_TO_FILE}`.

## License

If there is a license in a sub folder e.g. at `/contracts/oracle` then that applies for all files under it, otherwise refer to the license in the root folder.
