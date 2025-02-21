// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.23;

import "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import "@wormhole-solidity-sdk/interfaces/IERC20.sol";
import "@wormhole-solidity-sdk/interfaces/IWormhole.sol";
import "@wormhole-solidity-sdk/interfaces/IWormholeReceiver.sol";
import "@wormhole-solidity-sdk/interfaces/IWormholeRelayer.sol";
import "@wormhole-solidity-sdk/interfaces/CCTPInterfaces/ITokenMessenger.sol";
import "@wormhole-solidity-sdk/interfaces/CCTPInterfaces/IMessageTransmitter.sol";
import { CCTPMessageLib } from "@wormhole-solidity-sdk/CCTPBase.sol";

import "./interfaces/IBridgeAdapter.sol";
import "./interfaces/IBridgeRouter.sol";

import "./libraries/Messages.sol";
import "./libraries/Wormhole.sol";
import "./libraries/CCTPMessages.sol";

contract WormholeCCTPAdapter is IBridgeAdapter, IWormholeReceiver, AccessControlDefaultAdminRules {
    bytes32 public constant override MANAGER_ROLE = keccak256("MANAGER");

    event ReceiveMessage(bytes32 indexed messageId, bytes32 adapterAddress);

    error InvalidWormholeRelayer(address sender);
    error CircleTransmitterMintFail(bytes message);
    error InvalidCCTPSourceDomain(uint32 sourceDomain);
    error InvalidCCTPNonce(uint64 nonce);
    error InvalidAdditionalMessagesLength();

    struct WormholeCCTPAdapterParams {
        bool isAvailable;
        uint16 wormholeChainId;
        uint32 cctpDomainId;
        bytes32 adapterAddress;
    }

    mapping(uint16 folksChainId => WormholeCCTPAdapterParams) internal folksChainIdToWormholeAdapter;
    mapping(uint16 wormholeChainId => uint16 folksChainId) internal wormholeChainIdToFolksChainId;

    IWormhole public immutable wormhole;
    IWormholeRelayer public immutable wormholeRelayer;
    IBridgeRouter public immutable bridgeRouter;
    ITokenMessenger public immutable circleTokenMessenger;
    IMessageTransmitter public immutable circleMessageTransmitter;
    address public refundAddress;
    address public immutable circleToken;
    uint32 public immutable cctpSourceDomainId;

    modifier onlyBridgeRouter() {
        if (msg.sender != address(bridgeRouter)) revert InvalidBridgeRouter(msg.sender);
        _;
    }

    modifier onlyWormholeRelayer() {
        if (msg.sender != address(wormholeRelayer)) revert InvalidWormholeRelayer(msg.sender);
        _;
    }

    /**
     * @notice Constructor
     * @param admin The default admin for AccountManager
     * @param _wormhole The Wormhole Core to get message fees
     * @param _wormholeRelayer The Wormhole Relayer to relay messages using
     * @param _bridgeRouter The Bridge Router to route messages through
     * @param _circleMessageTransmitter Circle message passing used when receiving Circle Token
     * @param _circleTokenMessenger Entrypoint for cross-chain Circle Token transfer
     * @param _refundAddress The address to deliver any refund to
     * @param _circleToken Circle token address
     * @param _cctpSourceDomainId CCTP source chain id
     */
    constructor(
        address admin,
        IWormhole _wormhole,
        IWormholeRelayer _wormholeRelayer,
        IBridgeRouter _bridgeRouter,
        IMessageTransmitter _circleMessageTransmitter,
        ITokenMessenger _circleTokenMessenger,
        address _refundAddress,
        address _circleToken,
        uint32 _cctpSourceDomainId
    ) AccessControlDefaultAdminRules(1 days, admin) {
        wormhole = _wormhole;
        wormholeRelayer = _wormholeRelayer;
        bridgeRouter = _bridgeRouter;
        circleMessageTransmitter = _circleMessageTransmitter;
        circleTokenMessenger = _circleTokenMessenger;
        refundAddress = _refundAddress;
        circleToken = _circleToken;
        cctpSourceDomainId = _cctpSourceDomainId;
        _grantRole(MANAGER_ROLE, admin);
    }

    function getSendFee(Messages.MessageToSend memory message) external view override returns (uint256 fee) {
        // get chain adapter if available
        (uint16 wormholeChainId, , ) = getChainAdapter(message.destinationChainId);

        // get cost of message delivery
        uint256 deliveryCost;
        (deliveryCost, ) = wormholeRelayer.quoteEVMDeliveryPrice(
            wormholeChainId,
            message.params.receiverValue,
            message.params.gasLimit
        );

        // add cost of publishing message
        fee = deliveryCost + wormhole.messageFee();
    }

    function sendMessage(Messages.MessageToSend calldata message) external payable onlyBridgeRouter {
        // get chain adapter if available
        (uint16 wormholeChainId, bytes32 adapterAddress, uint32 cctpDestinationDomain) = getChainAdapter(
            message.destinationChainId
        );

        // must be finalised message
        if (message.finalityLevel == 0) revert InvalidFinalityLevel(message.finalityLevel);
        if (message.extraArgs.length == 0) revert EmptyExtraArgs();

        bytes memory payloadWithMetadata;
        MessageKey[] memory messageKeys;
        {
            // check extra args format and read
            Messages.ExtraArgsV1 memory extraArgs = Messages.bytesToExtraArgs(message.extraArgs);
            if (circleToken != Messages.convertGenericAddressToEVMAddress(extraArgs.token))
                revert InvalidTokenAddress(extraArgs.token);

            // burn Circle Token and retrieve info needed to pair with Wormhole message
            uint64 nonce;
            (messageKeys, nonce) = _transferCircleToken(
                extraArgs.amount,
                cctpDestinationDomain,
                extraArgs.recipient,
                adapterAddress
            );

            // prepare payload by adding metadata incl paired Circle Token transfer
            payloadWithMetadata = CCTPMessages.encodePayloadWithCCTPMetadata(
                cctpSourceDomainId,
                extraArgs.amount,
                nonce,
                extraArgs.recipient,
                message
            );
        }

        // send using wormhole relayer
        uint64 sequence = wormholeRelayer.sendToEvm{ value: msg.value }(
            wormholeChainId,
            Messages.convertGenericAddressToEVMAddress(adapterAddress),
            payloadWithMetadata,
            message.params.receiverValue,
            0,
            message.params.gasLimit,
            wormholeChainId,
            refundAddress,
            wormholeRelayer.getDefaultDeliveryProvider(),
            messageKeys,
            Wormhole.CONSISTENCY_LEVEL_FINALIZED
        );

        emit SendMessage(bytes32(uint256(sequence)), message);
    }

    function receiveWormholeMessages(
        bytes memory payload,
        bytes[] memory additionalMessages, // additional messages
        bytes32 sourceAddress, // address that called 'sendPayloadToEvm'
        uint16 sourceChain,
        bytes32 deliveryHash // unique identifier of delivery
    ) external payable override onlyWormholeRelayer {
        // validate source chain and source address
        uint16 folksChainId = wormholeChainIdToFolksChainId[sourceChain];
        (uint16 wormholeChainId, bytes32 adapterAddress, uint32 cctpDomainId) = getChainAdapter(folksChainId);
        if (sourceChain != wormholeChainId) revert ChainUnavailable(folksChainId);
        if (adapterAddress != sourceAddress) revert InvalidMessageSender(sourceAddress);

        // decode into metadata and message payload
        (CCTPMessages.CCTPMetadata memory cctpMetadata, bytes memory messagePayload) = CCTPMessages
            .decodePayloadWithCCTPMetadata(payload);

        // ensure the Wormhole message has been paired with correct Circle Token transfer
        if (additionalMessages.length != 1) revert InvalidAdditionalMessagesLength();
        if (cctpDomainId != cctpMetadata.sourceDomainId) revert InvalidCCTPSourceDomain(cctpMetadata.sourceDomainId);
        (bytes memory message, bytes memory signature) = abi.decode(additionalMessages[0], (bytes, bytes));
        if (cctpMetadata.nonce != CCTPMessages.getNonceFromCCTPMessage(message))
            revert InvalidCCTPNonce(cctpMetadata.nonce);

        // redeem Circle Token and ensure it was actually received
        uint256 receivedAmount = _redeemCircleToken(message, signature, cctpMetadata.recipient);
        if (cctpMetadata.amount != receivedAmount) revert InvalidReceivedAmount(cctpMetadata.amount, receivedAmount);

        // construct and forward message to bridge router
        Messages.MessageReceived memory messageReceived = Messages.MessageReceived({
            messageId: deliveryHash,
            sourceChainId: wormholeChainIdToFolksChainId[sourceChain],
            sourceAddress: cctpMetadata.messageMetadata.sender,
            handler: cctpMetadata.messageMetadata.handler,
            payload: messagePayload,
            returnAdapterId: cctpMetadata.messageMetadata.returnAdapterId,
            returnGasLimit: cctpMetadata.messageMetadata.returnGasLimit
        });
        bridgeRouter.receiveMessage{ value: msg.value }(messageReceived);

        emit ReceiveMessage(messageReceived.messageId, adapterAddress);
    }

    function setRefundAddress(address _refundAddress) external onlyRole(MANAGER_ROLE) {
        refundAddress = _refundAddress;
    }

    function addChain(
        uint16 folksChainId,
        uint16 wormholeChainId,
        uint32 cctpDomainId,
        bytes32 adapterAddress
    ) external onlyRole(MANAGER_ROLE) {
        // check if chain is already added
        bool isAvailable = isChainAvailable(folksChainId);
        if (isAvailable) revert ChainAlreadyAdded(folksChainId);

        folksChainIdToWormholeAdapter[folksChainId] = WormholeCCTPAdapterParams({
            isAvailable: true,
            wormholeChainId: wormholeChainId,
            cctpDomainId: cctpDomainId,
            adapterAddress: adapterAddress
        });
        wormholeChainIdToFolksChainId[wormholeChainId] = folksChainId;
    }

    function removeChain(uint16 folksChainId) external onlyRole(MANAGER_ROLE) {
        // get chain adapter if available
        (uint16 wormholeChainId, , ) = getChainAdapter(folksChainId);

        // remove chain
        delete folksChainIdToWormholeAdapter[folksChainId];
        delete wormholeChainIdToFolksChainId[wormholeChainId];
    }

    function isChainAvailable(uint16 chainId) public view override returns (bool) {
        return folksChainIdToWormholeAdapter[chainId].isAvailable;
    }

    function getChainAdapter(
        uint16 chainId
    ) public view returns (uint16 wormholeChainId, bytes32 adapterAddress, uint32 cctpDomainId) {
        WormholeCCTPAdapterParams memory chainAdapter = folksChainIdToWormholeAdapter[chainId];
        if (!chainAdapter.isAvailable) revert ChainUnavailable(chainId);

        wormholeChainId = chainAdapter.wormholeChainId;
        adapterAddress = chainAdapter.adapterAddress;
        cctpDomainId = chainAdapter.cctpDomainId;
    }

    function _transferCircleToken(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 receipientAddress,
        bytes32 destinationCaller
    ) internal returns (MessageKey[] memory, uint64) {
        // burn Circle Token
        IERC20(circleToken).approve(address(circleTokenMessenger), amount);
        uint64 nonce = circleTokenMessenger.depositForBurnWithCaller(
            amount,
            destinationDomain,
            receipientAddress,
            circleToken,
            destinationCaller
        );

        // return info so can pair Circle Token transfer with Wormhole message
        MessageKey[] memory messageKeys = new MessageKey[](1);
        messageKeys[0] = MessageKey(CCTPMessageLib.CCTP_KEY_TYPE, abi.encodePacked(cctpSourceDomainId, nonce));
        return (messageKeys, nonce);
    }

    function _redeemCircleToken(
        bytes memory message,
        bytes memory signature,
        bytes32 receipient
    ) internal returns (uint256) {
        // track balance of recipient before and after to ensure correct amount received
        address recipientAddress = Messages.convertGenericAddressToEVMAddress(receipient);
        uint256 beforeBalance = IERC20(circleToken).balanceOf(recipientAddress);

        // mint Circle Token
        bool success = circleMessageTransmitter.receiveMessage(message, signature);
        if (!success) revert CircleTransmitterMintFail(message);

        return IERC20(circleToken).balanceOf(recipientAddress) - beforeBalance;
    }
}
