// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.23;

import "./CCIPAdapter.sol";
import "./libraries/Messages.sol";

contract CCIPDataAdapter is CCIPAdapter {
    /**
     * @notice Constructor
     * @param admin The default admin for AccountManager
     * @param ccipRouter The CCIP router to relay messages using
     * @param bridgeRouter The Bridge Router to route messages through
     */
    constructor(
        address admin,
        IRouterClient ccipRouter,
        IBridgeRouter bridgeRouter
    ) CCIPAdapter(admin, ccipRouter, bridgeRouter) {}

    function sendMessage(Messages.MessageToSend calldata message) external payable override onlyBridgeRouter {
        // get chain adapter if available
        (uint64 ccipChainId, bytes32 adapterAddress) = getChainAdapter(message.destinationChainId);

        // ensure receiver value is zero and extra args is empty
        // adapter doesn't support immediate finality but no strict check
        if (message.params.receiverValue > 0) revert UnsupportedReceiverValue();
        if (message.extraArgs.length > 0) revert UnsupportedExtraArgs();

        // send using ccip router
        Client.EVM2AnyMessage memory ccipMessage = _buildCCIPMessage(adapterAddress, message);
        bytes32 messageId = ccipRouter.ccipSend{ value: msg.value }(ccipChainId, ccipMessage);

        emit SendMessage(messageId, message);
    }

    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        (Messages.MessageMetadata memory metadata, bytes memory messagePayload) = Messages.decodePayloadWithMetadata(
            message.data
        );

        // check source chain and source address
        uint16 folksChainId = ccipChainIdToFolksChainId[message.sourceChainSelector];
        bytes32 sourceAddress = Messages.convertEVMAddressToGenericAddress(abi.decode(message.sender, (address)));
        (uint64 ccipChainId, bytes32 adapterAddress) = getChainAdapter(folksChainId);
        if (message.sourceChainSelector != ccipChainId) revert ChainUnavailable(folksChainId);
        if (adapterAddress != sourceAddress) revert InvalidMessageSender(sourceAddress);

        // construct and forward message to bridge router
        Messages.MessageReceived memory messageReceived = Messages.MessageReceived({
            messageId: message.messageId,
            sourceChainId: folksChainId,
            sourceAddress: metadata.sender,
            handler: metadata.handler,
            payload: messagePayload,
            returnAdapterId: metadata.returnAdapterId,
            returnGasLimit: metadata.returnGasLimit
        });
        bridgeRouter.receiveMessage(messageReceived);

        emit ReceiveMessage(messageReceived.messageId);
    }

    /// @notice Construct a CCIP message.
    /// @dev This function will create an EVM2AnyMessage struct with all the necessary information for sending a text.
    /// @return Client.EVM2AnyMessage Returns an EVM2AnyMessage struct which contains information for sending a CCIP message.
    function _buildCCIPMessage(
        bytes32 adapterAddress,
        Messages.MessageToSend calldata message
    ) internal pure override returns (Client.EVM2AnyMessage memory) {
        // prepare target address and payload
        address targetAddress = Messages.convertGenericAddressToEVMAddress(adapterAddress);
        bytes memory payloadWithMetadata = Messages.encodePayloadWithMetadata(message);

        // Create an EVM2AnyMessage struct in memory with necessary information for sending a cross-chain message
        return
            Client.EVM2AnyMessage({
                receiver: abi.encode(targetAddress),
                data: payloadWithMetadata,
                tokenAmounts: new Client.EVMTokenAmount[](0),
                feeToken: address(0),
                extraArgs: Client._argsToBytes(Client.EVMExtraArgsV1({ gasLimit: message.params.gasLimit }))
            });
    }
}
